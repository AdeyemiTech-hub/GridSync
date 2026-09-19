// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title GreenHourRegistry
/// @notice Mints hourly, meter-tied ERC-1155 certificates for energy used in a
///         green grid hour. 1 token = 1 Wh. certId = keccak256(meterId, hourId).
/// @dev Trust model (hackathon MVP): a single trusted oracle posts grid hours and
///      the meter is simulated; its signing key is the registered `owner` address.
contract GreenHourRegistry is ERC1155, Ownable {
    struct Meter {
        address owner;
        bytes32 region;
    }

    struct GridHour {
        bool posted;
        uint32 gCO2PerKwh;
        uint256 greenCapacityWh;
        uint256 attestedWh;
    }

    /// @notice Max gCO2/kWh for an hour to be considered green (inclusive).
    uint32 public immutable greenThreshold;
    address public oracle;

    mapping(bytes32 meterId => Meter) public meters;
    mapping(bytes32 region => mapping(uint256 hourId => GridHour)) public gridHours;
    mapping(bytes32 claimKey => bool) public claimed;

    event MeterRegistered(bytes32 indexed meterId, address indexed owner, bytes32 region);
    event OracleUpdated(address indexed oracle);
    event HourPosted(bytes32 indexed region, uint256 indexed hourId, uint32 gCO2PerKwh, uint256 greenCapacityWh);
    event UsageAttested(bytes32 indexed meterId, uint256 indexed hourId, uint256 indexed certId, uint256 wh);
    event Retired(uint256 indexed certId, address indexed account, uint256 amount, address beneficiary);

    error NotOracle();
    error MeterAlreadyRegistered();
    error MeterNotRegistered();
    error HourNotPosted();
    error HourAlreadyPosted();
    error ZeroAmount();
    error InvalidSignature();
    error AlreadyClaimed();
    error HourNotGreen();
    error CapacityExceeded();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(address initialOwner, address initialOracle, uint32 greenThreshold_)
        ERC1155("")
        Ownable(initialOwner)
    {
        oracle = initialOracle;
        greenThreshold = greenThreshold_;
        emit OracleUpdated(initialOracle);
    }

    function setOracle(address newOracle) external onlyOwner {
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    function registerMeter(bytes32 meterId, address owner_, bytes32 region) external onlyOwner {
        if (meters[meterId].owner != address(0)) revert MeterAlreadyRegistered();
        meters[meterId] = Meter(owner_, region);
        emit MeterRegistered(meterId, owner_, region);
    }

    /// @notice Oracle publishes a grid hour. Immutable once posted.
    function postGridHour(bytes32 region, uint256 hourId, uint32 gCO2PerKwh, uint256 greenCapacityWh)
        external
        onlyOracle
    {
        GridHour storage h = gridHours[region][hourId];
        if (h.posted) revert HourAlreadyPosted();
        h.posted = true;
        h.gCO2PerKwh = gCO2PerKwh;
        h.greenCapacityWh = greenCapacityWh;
        emit HourPosted(region, hourId, gCO2PerKwh, greenCapacityWh);
    }

    /// @notice Digest the meter signs (EIP-191 personal_sign over this hash).
    function usageDigest(bytes32 meterId, uint256 hourId, uint256 wh) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), meterId, hourId, wh));
    }

    function certId(bytes32 meterId, uint256 hourId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(meterId, hourId)));
    }

    /// @notice Submit a meter-signed reading; mints `wh` certificate units to the meter owner.
    function attestUsage(bytes32 meterId, uint256 hourId, uint256 wh, bytes calldata sig) external {
        if (wh == 0) revert ZeroAmount();
        Meter memory m = meters[meterId];
        if (m.owner == address(0)) revert MeterNotRegistered();

        bytes32 signed = MessageHashUtils.toEthSignedMessageHash(usageDigest(meterId, hourId, wh));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(signed, sig);
        if (err != ECDSA.RecoverError.NoError || signer != m.owner) revert InvalidSignature();

        bytes32 key = keccak256(abi.encode(meterId, hourId));
        if (claimed[key]) revert AlreadyClaimed();

        GridHour storage h = gridHours[m.region][hourId];
        if (!h.posted) revert HourNotPosted();
        if (h.gCO2PerKwh > greenThreshold) revert HourNotGreen();
        if (h.attestedWh + wh > h.greenCapacityWh) revert CapacityExceeded();

        claimed[key] = true;
        h.attestedWh += wh;

        uint256 id = certId(meterId, hourId);
        _mint(m.owner, id, wh, "");
        emit UsageAttested(meterId, hourId, id, wh);
    }

    /// @notice Burn certificates held by the caller, recording who benefits.
    function retire(uint256 id, uint256 amount, address beneficiary) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, id, amount);
        emit Retired(id, msg.sender, amount, beneficiary);
    }
}
