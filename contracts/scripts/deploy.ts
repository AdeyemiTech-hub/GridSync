import { ethers, network } from "hardhat";

// Usage: npm run deploy:base-sepolia   (reads ../.env; see .env.example)
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env");
  }

  const oracle = process.env.ORACLE_ADDRESS || deployer.address;
  const threshold = Number(process.env.GREEN_THRESHOLD_G_CO2_PER_KWH || "150");

  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Oracle:    ${oracle}`);
  console.log(`Threshold: ${threshold} gCO2/kWh`);

  const registry = await ethers.deployContract("GreenHourRegistry", [
    deployer.address,
    oracle,
    threshold,
  ]);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`GreenHourRegistry deployed to: ${address}`);
  console.log(
    `Verify: npx hardhat verify --network ${network.name} ${address} ${deployer.address} ${oracle} ${threshold}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
