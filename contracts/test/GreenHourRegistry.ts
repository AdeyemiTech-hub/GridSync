import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const REGION = ethers.encodeBytes32String("GB");
const METER = ethers.encodeBytes32String("meter-1");
const HOUR = 480_000n; // hourId = unix hours
const THRESHOLD = 150;
const GREEN_G = 90;
const DIRTY_G = 300;
const CAPACITY_WH = 10_000n;

describe("GreenHourRegistry", () => {
  async function deploy() {
    const [admin, oracle, household, other, buyer] = await ethers.getSigners();
    const registry = await ethers.deployContract("GreenHourRegistry", [
      admin.address,
      oracle.address,
      THRESHOLD,
    ]);
    // The simulated meter signs with the registered owner's key.
    await registry.registerMeter(METER, household.address, REGION);
    return { registry, admin, oracle, household, other, buyer };
  }

  async function sign(
    registry: Awaited<ReturnType<typeof deploy>>["registry"],
    signer: Awaited<ReturnType<typeof deploy>>["household"],
    meterId: string,
    hourId: bigint,
    wh: bigint,
  ) {
    const digest = await registry.usageDigest(meterId, hourId, wh);
    return signer.signMessage(ethers.getBytes(digest));
  }

  async function withGreenHour() {
    const f = await deploy();
    await f.registry.connect(f.oracle).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH);
    return f;
  }

  describe("postGridHour", () => {
    it("lets the oracle post an hour and emits HourPosted", async () => {
      const { registry, oracle } = await loadFixture(deploy);
      await expect(registry.connect(oracle).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH))
        .to.emit(registry, "HourPosted")
        .withArgs(REGION, HOUR, GREEN_G, CAPACITY_WH);
    });

    it("reverts NotOracle when called by anyone else (including the owner)", async () => {
      const { registry, admin, other } = await loadFixture(deploy);
      await expect(
        registry.connect(other).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH),
      ).to.be.revertedWithCustomError(registry, "NotOracle");
      await expect(
        registry.connect(admin).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH),
      ).to.be.revertedWithCustomError(registry, "NotOracle");
    });

    it("reverts HourAlreadyPosted on a second post for the same region+hour", async () => {
      const { registry, oracle } = await loadFixture(withGreenHour);
      await expect(
        registry.connect(oracle).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH),
      ).to.be.revertedWithCustomError(registry, "HourAlreadyPosted");
    });
  });

  describe("registerMeter", () => {
    it("reverts for non-owners", async () => {
      const { registry, other } = await loadFixture(deploy);
      await expect(
        registry.connect(other).registerMeter(ethers.encodeBytes32String("m2"), other.address, REGION),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("reverts MeterAlreadyRegistered on duplicate ids", async () => {
      const { registry, other } = await loadFixture(deploy);
      await expect(registry.registerMeter(METER, other.address, REGION)).to.be.revertedWithCustomError(
        registry,
        "MeterAlreadyRegistered",
      );
    });
  });

  describe("attestUsage", () => {
    it("mints wh certificate units to the meter owner and emits UsageAttested", async () => {
      const { registry, household } = await loadFixture(withGreenHour);
      const wh = 4_000n;
      const sig = await sign(registry, household, METER, HOUR, wh);
      const id = await registry.certId(METER, HOUR);

      await expect(registry.attestUsage(METER, HOUR, wh, sig))
        .to.emit(registry, "UsageAttested")
        .withArgs(METER, HOUR, id, wh);

      expect(await registry.balanceOf(household.address, id)).to.equal(wh);
      expect((await registry.gridHours(REGION, HOUR)).attestedWh).to.equal(wh);
    });

    it("reverts AlreadyClaimed for a second attestation of the same meter+hour", async () => {
      const { registry, household } = await loadFixture(withGreenHour);
      const sig = await sign(registry, household, METER, HOUR, 1_000n);
      await registry.attestUsage(METER, HOUR, 1_000n, sig);

      const sig2 = await sign(registry, household, METER, HOUR, 500n);
      await expect(registry.attestUsage(METER, HOUR, 500n, sig2)).to.be.revertedWithCustomError(
        registry,
        "AlreadyClaimed",
      );
    });

    it("reverts HourNotGreen when the hour is above the threshold", async () => {
      const { registry, oracle, household } = await loadFixture(deploy);
      await registry.connect(oracle).postGridHour(REGION, HOUR, DIRTY_G, CAPACITY_WH);
      const sig = await sign(registry, household, METER, HOUR, 1_000n);
      await expect(registry.attestUsage(METER, HOUR, 1_000n, sig)).to.be.revertedWithCustomError(
        registry,
        "HourNotGreen",
      );
    });

    it("treats the threshold itself as green (inclusive)", async () => {
      const { registry, oracle, household } = await loadFixture(deploy);
      await registry.connect(oracle).postGridHour(REGION, HOUR, THRESHOLD, CAPACITY_WH);
      const sig = await sign(registry, household, METER, HOUR, 1_000n);
      await expect(registry.attestUsage(METER, HOUR, 1_000n, sig)).to.emit(registry, "UsageAttested");
    });

    it("reverts CapacityExceeded when region-hour green capacity is used up", async () => {
      const { registry, oracle, household, other } = await loadFixture(deploy);
      const meter2 = ethers.encodeBytes32String("meter-2");
      await registry.registerMeter(meter2, other.address, REGION);
      await registry.connect(oracle).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH);

      // Household takes 7,000 of 10,000 Wh; the second meter asks for 4,000.
      await registry.attestUsage(METER, HOUR, 7_000n, await sign(registry, household, METER, HOUR, 7_000n));
      const sig2 = await sign(registry, other, meter2, HOUR, 4_000n);
      await expect(registry.attestUsage(meter2, HOUR, 4_000n, sig2)).to.be.revertedWithCustomError(
        registry,
        "CapacityExceeded",
      );

      // Exactly the remaining 3,000 still fits.
      const sig3 = await sign(registry, other, meter2, HOUR, 3_000n);
      await expect(registry.attestUsage(meter2, HOUR, 3_000n, sig3)).to.emit(registry, "UsageAttested");
    });

    it("reverts InvalidSignature when signed by someone other than the meter", async () => {
      const { registry, other } = await loadFixture(withGreenHour);
      const sig = await sign(registry, other, METER, HOUR, 1_000n);
      await expect(registry.attestUsage(METER, HOUR, 1_000n, sig)).to.be.revertedWithCustomError(
        registry,
        "InvalidSignature",
      );
    });

    it("reverts InvalidSignature when the reading was tampered with after signing", async () => {
      const { registry, household } = await loadFixture(withGreenHour);
      const sig = await sign(registry, household, METER, HOUR, 1_000n);
      await expect(registry.attestUsage(METER, HOUR, 2_000n, sig)).to.be.revertedWithCustomError(
        registry,
        "InvalidSignature",
      );
    });

    it("reverts InvalidSignature on a malformed signature", async () => {
      const { registry } = await loadFixture(withGreenHour);
      await expect(registry.attestUsage(METER, HOUR, 1_000n, "0x1234")).to.be.revertedWithCustomError(
        registry,
        "InvalidSignature",
      );
    });

    it("reverts HourNotPosted when the oracle has not posted the hour", async () => {
      const { registry, household } = await loadFixture(deploy);
      const sig = await sign(registry, household, METER, HOUR, 1_000n);
      await expect(registry.attestUsage(METER, HOUR, 1_000n, sig)).to.be.revertedWithCustomError(
        registry,
        "HourNotPosted",
      );
    });

    it("reverts MeterNotRegistered for an unknown meter", async () => {
      const { registry, household } = await loadFixture(withGreenHour);
      const ghost = ethers.encodeBytes32String("ghost");
      const sig = await sign(registry, household, ghost, HOUR, 1_000n);
      await expect(registry.attestUsage(ghost, HOUR, 1_000n, sig)).to.be.revertedWithCustomError(
        registry,
        "MeterNotRegistered",
      );
    });

    it("reverts ZeroAmount for a zero-Wh reading", async () => {
      const { registry, household } = await loadFixture(withGreenHour);
      const sig = await sign(registry, household, METER, HOUR, 0n);
      await expect(registry.attestUsage(METER, HOUR, 0n, sig)).to.be.revertedWithCustomError(
        registry,
        "ZeroAmount",
      );
    });
  });

  describe("retire", () => {
    async function withCert() {
      const f = await withGreenHour();
      const wh = 4_000n;
      await f.registry.attestUsage(METER, HOUR, wh, await sign(f.registry, f.household, METER, HOUR, wh));
      const id = await f.registry.certId(METER, HOUR);
      return { ...f, id, wh };
    }

    it("burns the certificate and emits Retired with the beneficiary", async () => {
      const { registry, household, buyer, id, wh } = await loadFixture(withCert);
      await expect(registry.connect(household).retire(id, 1_500n, buyer.address))
        .to.emit(registry, "Retired")
        .withArgs(id, household.address, 1_500n, buyer.address);
      expect(await registry.balanceOf(household.address, id)).to.equal(wh - 1_500n);
    });

    it("works for a buyer who received the certificate via transfer", async () => {
      const { registry, household, buyer, id } = await loadFixture(withCert);
      await registry.connect(household).safeTransferFrom(household.address, buyer.address, id, 1_000n, "0x");
      await expect(registry.connect(buyer).retire(id, 1_000n, buyer.address))
        .to.emit(registry, "Retired")
        .withArgs(id, buyer.address, 1_000n, buyer.address);
      expect(await registry.balanceOf(buyer.address, id)).to.equal(0n);
    });

    it("reverts when retiring more than the caller holds", async () => {
      const { registry, household, buyer, id, wh } = await loadFixture(withCert);
      await expect(registry.connect(household).retire(id, wh + 1n, buyer.address)).to.be.revertedWithCustomError(
        registry,
        "ERC1155InsufficientBalance",
      );
    });

    it("reverts when the caller holds none of that certificate", async () => {
      const { registry, other, id } = await loadFixture(withCert);
      await expect(registry.connect(other).retire(id, 1n, other.address)).to.be.revertedWithCustomError(
        registry,
        "ERC1155InsufficientBalance",
      );
    });

    it("reverts ZeroAmount when retiring nothing", async () => {
      const { registry, household, buyer, id } = await loadFixture(withCert);
      await expect(registry.connect(household).retire(id, 0n, buyer.address)).to.be.revertedWithCustomError(
        registry,
        "ZeroAmount",
      );
    });
  });

  describe("setOracle", () => {
    it("lets the owner rotate the oracle and blocks the old one", async () => {
      const { registry, admin, oracle, other } = await loadFixture(deploy);
      await registry.connect(admin).setOracle(other.address);
      await expect(
        registry.connect(oracle).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH),
      ).to.be.revertedWithCustomError(registry, "NotOracle");
      await expect(registry.connect(other).postGridHour(REGION, HOUR, GREEN_G, CAPACITY_WH)).to.emit(
        registry,
        "HourPosted",
      );
    });

    it("reverts for non-owners", async () => {
      const { registry, other } = await loadFixture(deploy);
      await expect(registry.connect(other).setOracle(other.address)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
