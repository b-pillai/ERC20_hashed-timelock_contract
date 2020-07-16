pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "./HashedTimelockERC20.sol";

contract BurnToClaim is HashedTimelockERC20 {
    function exitTransaction(
        address _burnAddress,
        bytes32 _hashlock,
        uint256 _timelock,
        address _tokenContract,
        uint256 _amount
    ) external returns (bytes32) {
        bytes32 result = newContract(
            _burnAddress,
            _hashlock,
            _timelock,
            _tokenContract,
            _amount
        );
        return result;
    }

    function entryTransaction(bytes32 _contractId, bytes32 _preimage) public returns (bool) {
        bool result = withdraw(_contractId, _preimage);
        return result;
    }

    function reclaimTransaction(bytes32 _contractId)
        public
        returns (bool)
    {
        bool result = refund(_contractId);
        return result;
    }
}
