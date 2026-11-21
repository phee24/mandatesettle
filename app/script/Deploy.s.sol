// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {A2AEscrow} from "../contracts/A2AEscrow.sol";
import {MockERC20} from "../contracts/MockERC20.sol";

/// @notice Deploys the settlement gateway. On testnet it also deploys a mock
///         stablecoin for the demo. Usage:
///         forge script script/Deploy.s.sol --rpc-url hsk_testnet --broadcast \
///           --private-key $DEPLOYER_PRIVATE_KEY
///         Set DEPLOY_MOCK_TOKEN=1 to also deploy MockERC20 (testnet/local only).
contract Deploy is Script {
    function run() external {
        uint64 settleWindow = uint64(vm.envOr("SETTLE_WINDOW_SECONDS", uint256(3600)));
        bool deployMock = vm.envOr("DEPLOY_MOCK_TOKEN", false);

        vm.startBroadcast();
        A2AEscrow escrow = new A2AEscrow(settleWindow);
        console.log("A2AEscrow:", address(escrow));
        if (deployMock) {
            MockERC20 mock = new MockERC20("Test USD Coin", "tUSDC", 6);
            console.log("MockERC20 (tUSDC):", address(mock));
        }
        vm.stopBroadcast();
    }
}
