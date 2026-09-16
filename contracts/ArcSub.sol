// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ArcSub — On-chain subscriptions / recurring payments for Pay on Arc
 * Arc (mainnet 5042, testnet 5042002) · USDC ERC-20 interface: 0x3600000000000000000000000000000000000000
 *
 * Model: allowance-pull. Funds stay in the subscriber's wallet.
 * - subscribe(): first period is charged immediately, next charge scheduled
 * - charge(): anyone can trigger a due payment (merchant, keeper, cron)
 * - cancel(): subscriber OR merchant can stop it anytime
 * No lockups, no custody — the contract never holds funds.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract ArcSub {
    IERC20 public immutable usdc;
    uint256 public nextId = 1;

    struct Sub {
        address subscriber;
        address merchant;
        uint96 amount;      // per period, 6 decimals
        uint32 interval;    // seconds
        uint40 nextCharge;  // timestamp
        bool active;
        string label;
    }

    mapping(uint256 => Sub) public subs;
    mapping(address => uint256[]) private bySubscriber;
    mapping(address => uint256[]) private byMerchant;

    event SubCreated(uint256 indexed id, address indexed subscriber, address indexed merchant, uint96 amount, uint32 interval, string label);
    event Charged(uint256 indexed id, address indexed merchant, uint96 amount, uint40 nextCharge);
    event Cancelled(uint256 indexed id, address by);
    /// A due subscription chargeMany() could not collect (allowance revoked, balance short).
    event ChargeSkipped(uint256 indexed id);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    /// Approve this contract for USDC first. First period is charged now.
    function subscribe(address merchant, uint96 amount, uint32 interval, string calldata label) external returns (uint256 id) {
        require(merchant != address(0), "zero merchant");
        require(merchant != msg.sender, "self subscription");
        require(amount > 0, "zero amount");
        require(interval >= 300, "interval too short"); // min 5 minutes (testnet demo friendly)
        require(bytes(label).length <= 64, "label too long");

        id = nextId++;
        subs[id] = Sub({
            subscriber: msg.sender,
            merchant: merchant,
            amount: amount,
            interval: interval,
            nextCharge: uint40(block.timestamp + interval),
            active: true,
            label: label
        });
        bySubscriber[msg.sender].push(id);
        byMerchant[merchant].push(id);

        require(usdc.transferFrom(msg.sender, merchant, amount), "first charge failed");

        emit SubCreated(id, msg.sender, merchant, amount, interval, label);
        emit Charged(id, merchant, amount, uint40(block.timestamp + interval));
    }

    /// Anyone can trigger a due charge — merchant, a keeper bot, a cron job.
    function charge(uint256 id) public {
        Sub storage s = subs[id];
        require(s.active, "inactive");
        require(block.timestamp >= s.nextCharge, "not due yet");

        // schedule next period; if several periods were missed, don't pile debt —
        // one charge per call, next due one interval from now
        uint256 scheduled = uint256(s.nextCharge) + s.interval;
        s.nextCharge = scheduled > block.timestamp
            ? uint40(scheduled)
            : uint40(block.timestamp + s.interval);

        require(usdc.transferFrom(s.subscriber, s.merchant, s.amount), "charge failed");
        emit Charged(id, s.merchant, s.amount, s.nextCharge);
    }

    /// Batch-collect: skips subs that aren't due, and reports the due ones it could not charge.
    function chargeMany(uint256[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) {
            Sub storage s = subs[ids[i]];
            if (!s.active || block.timestamp < s.nextCharge) continue;
            try this.charge(ids[i]) {} catch { emit ChargeSkipped(ids[i]); }
        }
    }

    function cancel(uint256 id) external {
        Sub storage s = subs[id];
        require(s.active, "already inactive");
        require(msg.sender == s.subscriber || msg.sender == s.merchant, "not a party");
        s.active = false;
        emit Cancelled(id, msg.sender);
    }

    // ---------------- Views ----------------

    function listBySubscriber(address a) external view returns (uint256[] memory) {
        return bySubscriber[a];
    }

    function listByMerchant(address a) external view returns (uint256[] memory) {
        return byMerchant[a];
    }

    function getSub(uint256 id)
        external
        view
        returns (address subscriber, address merchant, uint96 amount, uint32 interval, uint40 nextChargeAt, bool active, string memory label)
    {
        Sub storage s = subs[id];
        return (s.subscriber, s.merchant, s.amount, s.interval, s.nextCharge, s.active, s.label);
    }
}
