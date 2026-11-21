// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {A2AEscrow} from "../contracts/A2AEscrow.sol";
import {MockERC20} from "../contracts/MockERC20.sol";

contract A2AEscrowTest is Test {
    A2AEscrow internal escrow;
    MockERC20 internal usdc;

    uint256 internal payerPk = 0xB0B;
    uint256 internal payeePk = 0xA11CE;
    address internal payer;
    address internal payee;
    address internal relayer = address(0x12347);

    uint256 internal constant AMOUNT = 100e6; // 100 test USDC (6 decimals)
    uint64 internal constant WINDOW = 1 hours;

    function setUp() public {
        payer = vm.addr(payerPk);
        payee = vm.addr(payeePk);
        escrow = new A2AEscrow(WINDOW);
        usdc = new MockERC20("Test USD Coin", "tUSDC", 6);
        usdc.mint(payer, 1_000e6);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------- helpers
    function _mandate(uint256 nonce, uint256 amount) internal view returns (A2AEscrow.PaymentMandate memory) {
        return A2AEscrow.PaymentMandate({
            payer: payer,
            payee: payee,
            token: address(usdc),
            amount: amount,
            taskHash: keccak256("invoice#001: translate landing page"),
            expiry: uint64(block.timestamp + 1 days),
            nonce: nonce
        });
    }

    function _sign(A2AEscrow.PaymentMandate memory m, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.hashMandate(m));
        return abi.encodePacked(r, s, v);
    }

    function _fund(uint256 nonce) internal returns (bytes32 mh, A2AEscrow.PaymentMandate memory m) {
        m = _mandate(nonce, AMOUNT);
        bytes memory sig = _sign(m, payerPk);
        vm.prank(relayer); // anyone may relay a signed mandate
        mh = escrow.createMandate(m, sig);
    }

    // --------------------------------------------------------------- tests
    function test_fullLifecycle_payerConfirms() public {
        (bytes32 mh,) = _fund(1);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(uint8(escrow.getRecord(mh).status), uint8(A2AEscrow.Status.Funded));

        bytes32 proof = keccak256("deliverable: translated copy v1");
        vm.prank(payee);
        escrow.submitDelivery(mh, proof);
        assertEq(uint8(escrow.getRecord(mh).status), uint8(A2AEscrow.Status.Delivered));

        vm.prank(payer);
        escrow.confirmAndSettle(mh);
        assertEq(uint8(escrow.getRecord(mh).status), uint8(A2AEscrow.Status.Settled));
        assertEq(usdc.balanceOf(payee), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_settleAfterWindow_permissionless() public {
        (bytes32 mh,) = _fund(2);
        vm.prank(payee);
        escrow.submitDelivery(mh, keccak256("proof"));

        vm.expectRevert("window not lapsed");
        escrow.settleAfterWindow(mh);

        vm.warp(block.timestamp + WINDOW + 1);
        escrow.settleAfterWindow(mh); // called by test contract = anyone
        assertEq(usdc.balanceOf(payee), AMOUNT);
    }

    function test_refundAfterExpiry_noDelivery() public {
        (bytes32 mh,) = _fund(3);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectRevert("not yet expired");
        escrow.refund(mh);

        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(mh);
        assertEq(usdc.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(uint8(escrow.getRecord(mh).status), uint8(A2AEscrow.Status.Refunded));
    }

    function test_rejectBadSignature() public {
        A2AEscrow.PaymentMandate memory m = _mandate(4, AMOUNT);
        bytes memory sig = _sign(m, payeePk); // signed by payee, not payer
        vm.expectRevert("invalid mandate signature");
        escrow.createMandate(m, sig);
    }

    function test_rejectTamperedAmount() public {
        A2AEscrow.PaymentMandate memory m = _mandate(5, AMOUNT);
        bytes memory sig = _sign(m, payerPk);
        m.amount = AMOUNT * 2; // tamper after signing
        vm.expectRevert("invalid mandate signature");
        escrow.createMandate(m, sig);
    }

    function test_rejectNonceReuse() public {
        _fund(6);
        A2AEscrow.PaymentMandate memory m = _mandate(6, AMOUNT);
        bytes memory sig = _sign(m, payerPk);
        vm.expectRevert("nonce already used");
        escrow.createMandate(m, sig);
    }

    function test_rejectExpiredMandate() public {
        A2AEscrow.PaymentMandate memory m = _mandate(7, AMOUNT);
        m.expiry = uint64(block.timestamp - 1);
        // re-sign with the expired terms; signature is valid but mandate is stale
        bytes memory sig = _sign(m, payerPk);
        vm.expectRevert("mandate expired");
        escrow.createMandate(m, sig);
    }

    function test_rejectDeliveryByNonPayee() public {
        (bytes32 mh,) = _fund(8);
        vm.prank(payer);
        vm.expectRevert("only payee");
        escrow.submitDelivery(mh, keccak256("fake proof"));
    }

    function test_rejectSettleBeforeDelivery() public {
        (bytes32 mh,) = _fund(9);
        vm.prank(payer);
        vm.expectRevert("not delivered");
        escrow.confirmAndSettle(mh);
    }

    function test_rejectRefundAfterDelivery() public {
        (bytes32 mh,) = _fund(10);
        vm.prank(payee);
        escrow.submitDelivery(mh, keccak256("proof"));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert("not refundable");
        escrow.refund(mh);
    }
}
