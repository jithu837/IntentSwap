import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  const feeBps = 30; // 0.30%
  const IntentEscrow = await ethers.getContractFactory("IntentEscrow");
  const escrow = await IntentEscrow.deploy(feeBps);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log("IntentEscrow deployed to:", address);
  console.log("Fee BPS:", feeBps);
  console.log("Domain separator:", await escrow.DOMAIN_SEPARATOR());

  // Save addresses to a file for the backend to read
  const fs = await import("fs");
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    IntentEscrow: address,
    feeBps,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  fs.writeFileSync(
    "deployments.json",
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("Deployment info saved to deployments.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
