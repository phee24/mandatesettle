// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A2AEscrow — HSP-style mandate settlement gateway for agent-to-agent payments
/// @notice Implements the HashKey Settlement Protocol (HSP) A2A flow in a self-hosted
///         gateway contract:
///           1. A recipient (seller) agent publishes payment conditions.
///           2. A payer (buyer) agent signs an EIP-712 PaymentMandate (bounded
///              authorization: payee, token, amount, task hash, expiry, nonce).
///           3. Anyone relays the signed mandate; this contract verifies the
///              signature and escrows the funds.
///           4. The payee submits a delivery proof; the payer confirms (or a
///              challenge window lapses) and the escrow settles to the payee.
///           5. Every settlement emits a SettlementExecuted event — the
///              auditable, explorer-verifiable receipt.
///         The agent layer talks to this contract through an HspGateway adapter
///         so the official HSP gateway can be swapped in without agent changes.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract A2AEscrow {
    // ------------------------------------------------------------------ types
    struct PaymentMandate {
        address payer;
        address payee;
        address token;
        uint256 amount;
        bytes32 taskHash; // hash of the agreed task / invoice conditions
        uint64 expiry; // unix seconds; mandate + escrow refund deadline
        uint256 nonce; // per-payer replay protection
    }

    enum Status {
        None,
        Funded, // escrow holds the funds, awaiting delivery
        Delivered, // payee submitted a delivery proof
        Settled, // funds released to payee (terminal)
        Refunded // funds returned to payer after expiry (terminal)
    }

    struct MandateRecord {
        PaymentMandate mandate;
        Status status;
        bytes32 deliverableHash; // proof of delivery submitted by payee
        uint64 deliveredAt;
        uint64 settledAt;
    }

    // ----------------------------------------------------------------- events
    event MandateCreated(
        bytes32 indexed mandateHash,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint64 expiry
    );
    event DeliverySubmitted(bytes32 indexed mandateHash, address indexed payee, bytes32 deliverableHash);
    event SettlementExecuted(
        bytes32 indexed mandateHash,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 deliverableHash
    );
    event MandateRefunded(bytes32 indexed mandateHash, address indexed payer, uint256 amount);

    // ------------------------------------------------------------------ state
    string public constant NAME = "MandateSettle";
    string public constant VERSION = "1";

    bytes32 private constant _MANDATE_TYPEHASH = keccak256(
        "PaymentMandate(address payer,address payee,address token,uint256 amount,bytes32 taskHash,uint64 expiry,uint256 nonce)"
    );

    /// @notice Seconds after delivery during which the payer may dispute by
    ///         simply not confirming; after the window anyone may settle.
    uint64 public immutable settleWindow;

    mapping(bytes32 => MandateRecord) public records;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    constructor(uint64 settleWindow_) {
        settleWindow = settleWindow_;
    }

    // ------------------------------------------------------------- EIP-712
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function hashMandate(PaymentMandate calldata m) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_MANDATE_TYPEHASH, m.payer, m.payee, m.token, m.amount, m.taskHash, m.expiry, m.nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // -------------------------------------------------------------- lifecycle
    /// @notice Verify a payer-signed mandate and escrow the funds.
    /// @dev The payer signs off-chain; any relayer may submit. Funds move
    ///      payer -> this contract via transferFrom (payer must approve).
    function createMandate(PaymentMandate calldata m, bytes calldata signature) external returns (bytes32 mandateHash) {
        require(block.timestamp <= m.expiry, "mandate expired");
        require(m.amount > 0, "amount is zero");
        require(m.payer != address(0) && m.payee != address(0), "zero address");
        require(!usedNonces[m.payer][m.nonce], "nonce already used");

        mandateHash = hashMandate(m);
        address signer = _recover(mandateHash, signature);
        require(signer == m.payer, "invalid mandate signature");
        require(records[mandateHash].status == Status.None, "mandate already exists");

        usedNonces[m.payer][m.nonce] = true;
        require(IERC20(m.token).transferFrom(m.payer, address(this), m.amount), "escrow transfer failed");

        records[mandateHash].mandate = m;
        records[mandateHash].status = Status.Funded;

        emit MandateCreated(mandateHash, m.payer, m.payee, m.token, m.amount, m.taskHash, m.expiry);
    }

    /// @notice Payee submits proof of delivery (hash of the deliverable /
    ///         attestation). Moves the mandate to Delivered.
    function submitDelivery(bytes32 mandateHash, bytes32 deliverableHash) external {
        MandateRecord storage r = records[mandateHash];
        require(r.status == Status.Funded, "not funded");
        require(msg.sender == r.mandate.payee, "only payee");
        require(deliverableHash != bytes32(0), "empty proof");

        r.deliverableHash = deliverableHash;
        r.deliveredAt = uint64(block.timestamp);
        r.status = Status.Delivered;

        emit DeliverySubmitted(mandateHash, msg.sender, deliverableHash);
    }

    /// @notice Payer confirms delivery and settles immediately.
    function confirmAndSettle(bytes32 mandateHash) external {
        MandateRecord storage r = records[mandateHash];
        require(r.status == Status.Delivered, "not delivered");
        require(msg.sender == r.mandate.payer, "only payer");
        _settle(mandateHash, r);
    }

    /// @notice Permissionless settlement once the challenge window after
    ///         delivery has lapsed (the payer agent had time to object).
    function settleAfterWindow(bytes32 mandateHash) external {
        MandateRecord storage r = records[mandateHash];
        require(r.status == Status.Delivered, "not delivered");
        require(block.timestamp >= uint256(r.deliveredAt) + settleWindow, "window not lapsed");
        _settle(mandateHash, r);
    }

    /// @notice Refund the payer if no delivery happened before the mandate expiry.
    function refund(bytes32 mandateHash) external {
        MandateRecord storage r = records[mandateHash];
        require(r.status == Status.Funded, "not refundable");
        require(block.timestamp > r.mandate.expiry, "not yet expired");

        r.status = Status.Refunded;
        require(IERC20(r.mandate.token).transfer(r.mandate.payer, r.mandate.amount), "refund failed");

        emit MandateRefunded(mandateHash, r.mandate.payer, r.mandate.amount);
    }

    // ----------------------------------------------------------------- views
    function getRecord(bytes32 mandateHash) external view returns (MandateRecord memory) {
        return records[mandateHash];
    }

    // -------------------------------------------------------------- internal
    function _settle(bytes32 mandateHash, MandateRecord storage r) internal {
        r.status = Status.Settled;
        r.settledAt = uint64(block.timestamp);
        require(IERC20(r.mandate.token).transfer(r.mandate.payee, r.mandate.amount), "settlement failed");
        emit SettlementExecuted(
            mandateHash, r.mandate.payer, r.mandate.payee, r.mandate.token, r.mandate.amount, r.deliverableHash
        );
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad s value");
        require(v == 27 || v == 28, "bad v value");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
