pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

/**
 * A basic token for testing the Burn-to-Claim protocol.
 */
contract GriffithToken is ERC20 {
    string public constant name = "BGriffith Token";
    string public constant symbol = "GF";
    uint8 public constant decimals = 18;

    constructor(uint256 _initialBalance) public {
        _mint(msg.sender, _initialBalance);
    }
}
