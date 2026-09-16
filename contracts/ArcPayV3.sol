// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Pay on Arc — payments, splits and cancellable payments
/// @author Dnyelfy
///
/// A cancellable payment has one window. Inside it the money still belongs to
/// the sender and only the sender may cancel. Once it closes the money belongs
/// to the recipient and only the recipient may claim. There is no moment where
/// both can act and no moment where neither can — except for a payment nobody
/// has touched for ABANDON_AFTER past the window, which the sender may reclaim
/// so that a recipient who can never receive does not lock the funds forever.
contract ArcPayV3 {
    event PaymentSent(address indexed from, address indexed to, uint256 amount, string note);
    event ShareReturned(address indexed from, address indexed to, uint256 amount);
    event RecallableCreated(uint256 indexed id, address indexed from, address indexed to, uint256 amount, uint256 claimableAt, string note);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Recalled(uint256 indexed id, address indexed from, uint256 amount);

    uint256 public constant ABANDON_AFTER = 30 days;

    struct RPay {
        address from;
        address to;
        uint256 amount;
        uint256 claimableAt; // until this moment the sender may cancel; from it the recipient may claim
        uint8 status;        // 0 = open, 1 = claimed, 2 = cancelled
    }

    RPay[] public rpays;
    mapping(address => uint256[]) private _sent;
    mapping(address => uint256[]) private _received;

    /// Instant payment with an on-chain note.
    function pay(address payable to, string calldata note) external payable {
        require(msg.value > 0, "zero amount");
        (bool ok, ) = to.call{value: msg.value}("");
        require(ok, "transfer failed");
        emit PaymentSent(msg.sender, to, msg.value, note);
    }

    /// Equal split across 1-20 wallets.
    /// A recipient that refuses its share no longer sinks the whole batch: the
    /// refused share goes back to the sender together with the rounding dust,
    /// and that refund must succeed, so nothing is ever stranded in here.
    function splitPay(address payable[] calldata to, string calldata note) external payable {
        require(to.length > 0 && to.length <= 20, "1-20 recipients");
        uint256 share = msg.value / to.length;
        require(share > 0, "zero share");
        uint256 back = msg.value - share * to.length;
        for (uint256 i = 0; i < to.length; i++) {
            (bool ok, ) = to[i].call{value: share}("");
            if (ok) {
                emit PaymentSent(msg.sender, to[i], share, note);
            } else {
                back += share;
                emit ShareReturned(msg.sender, to[i], share);
            }
        }
        if (back > 0) {
            (bool ok2, ) = payable(msg.sender).call{value: back}("");
            require(ok2, "refund failed");
        }
    }

    /// Cancellable payment: the sender may cancel inside the window, the
    /// recipient may claim once it has closed.
    function payRecallable(address to, uint256 cancelSeconds, string calldata note) external payable returns (uint256 id) {
        require(msg.value > 0, "zero amount");
        require(to != address(0), "bad recipient");
        require(cancelSeconds >= 60 && cancelSeconds <= 30 days, "60s - 30d window");
        id = rpays.length;
        uint256 claimableAt = block.timestamp + cancelSeconds;
        rpays.push(RPay(msg.sender, to, msg.value, claimableAt, 0));
        _sent[msg.sender].push(id);
        _received[to].push(id);
        emit RecallableCreated(id, msg.sender, to, msg.value, claimableAt, note);
    }

    /// The recipient takes the money — only after the cancel window has closed.
    function claim(uint256 id) external {
        RPay storage p = rpays[id];
        require(p.status == 0, "not claimable");
        require(msg.sender == p.to, "not recipient");
        require(block.timestamp >= p.claimableAt, "still in cancel window");
        p.status = 1;
        (bool ok, ) = payable(p.to).call{value: p.amount}("");
        require(ok, "transfer failed");
        emit Claimed(id, p.to, p.amount);
    }

    /// The sender cancels — inside the window, or once the payment is abandoned.
    function recall(uint256 id) external {
        RPay storage p = rpays[id];
        require(p.status == 0, "not recallable");
        require(msg.sender == p.from, "not sender");
        require(
            block.timestamp < p.claimableAt || block.timestamp >= p.claimableAt + ABANDON_AFTER,
            "recipient window: cancel closed, not abandoned yet"
        );
        p.status = 2;
        (bool ok, ) = payable(p.from).call{value: p.amount}("");
        require(ok, "transfer failed");
        emit Recalled(id, p.from, p.amount);
    }

    function sentBy(address a) external view returns (uint256[] memory) { return _sent[a]; }
    function receivedBy(address a) external view returns (uint256[] memory) { return _received[a]; }
    function total() external view returns (uint256) { return rpays.length; }
}
