// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* Test doubles. Not deployed — used only by the Hardhat suite. */

/// Minimal 6-decimal ERC20, enough for ArcSub and TreasuryAgent.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// A token whose transferFrom re-enters ArcSub.charge on the same id.
contract ReentrantToken is MockERC20 {
    address public target;
    uint256 public reenterId;
    bool private inside;

    constructor() MockERC20("Reentrant", "RE") {}

    function arm(address _target, uint256 _id) external {
        target = _target;
        reenterId = _id;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (target != address(0) && !inside) {
            inside = true;
            (bool ok, ) = target.call(abi.encodeWithSignature("charge(uint256)", reenterId));
            ok; // the point is that it must fail; the outer transfer still settles
            inside = false;
        }
        return super.transferFrom(from, to, amount);
    }
}

/// Refuses every incoming native transfer.
contract RejectingReceiver {
    receive() external payable {
        revert("nope");
    }
}

/// Re-enters ArcPayV3.claim while being paid by it.
contract ReentrantClaimer {
    address public pay;
    uint256 public id;
    uint256 public reentries;

    function arm(address _pay, uint256 _id) external {
        pay = _pay;
        id = _id;
    }

    function go() external {
        (bool ok, ) = pay.call(abi.encodeWithSignature("claim(uint256)", id));
        require(ok, "outer claim failed");
    }

    receive() external payable {
        if (reentries < 3) {
            reentries++;
            (bool ok, ) = pay.call(abi.encodeWithSignature("claim(uint256)", id));
            ok; // expected to fail — the status guard should already be set
        }
    }
}

/// Calls splitPay but cannot take native currency back, so a refund to it fails.
contract RefusingSplitter {
    function split(address pay, address payable[] calldata to) external payable {
        (bool ok, bytes memory ret) = pay.call{value: msg.value}(
            abi.encodeWithSignature("splitPay(address[],string)", to, "x"));
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}

/// Pyth stub: a settable price, and a fee that must be paid exactly.
contract MockPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    Price private stored;
    uint256 public fee = 1;
    uint256 public updates;

    function set(int64 _price, uint64 _conf, int32 _expo) external {
        stored = Price(_price, _conf, _expo, block.timestamp);
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return fee;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        require(msg.value >= fee, "fee");
        stored.publishTime = block.timestamp;
        updates++;
    }

    function getPriceNoOlderThan(bytes32, uint256 age) external view returns (Price memory) {
        require(block.timestamp - stored.publishTime <= age, "stale");
        return stored;
    }
}
