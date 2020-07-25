pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

/**
 * @title BurnToClaim Contracts on Ethereum ERC20 tokens.
 *
 * This contracts provides a way to transfer tokens between users across chain.
 *
 * Protocol:
 *  1) exitTransaction(burnAddress, hashlock, timelock, tokenContract, amount)
 *     sender calls this to burn the token to a burnAdddress, returns contract id.
 *  2) entryTransaction(contractId, preimage) - once the receiver knows the preimage of
 *     the hashlock hash they can claim the tokens with this function, with in the timelock.
 *  3) reclaimTransaction(contractId) - after timelock has expired and if the receiver did not
 *     withdraw the tokens the sender can get their tokens back with this function.
 */
contract BurnToClaim {
    event HTLCERC20New(
        bytes32 indexed contractId,
        address indexed sender,
        address indexed receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event HTLCERC20Withdraw(bytes32 indexed contractId);
    event HTLCERC20Refund(bytes32 indexed contractId);

    struct LockContract {
        address sender;
        address receiver;
        address tokenContract;
        uint256 amount;
        bytes32 hashlock;
        // locked UNTIL this time. Unit depends on consensus algorithm.
        // PoA, PoA and IBFT all use seconds. But Quorum Raft uses nano-seconds
        uint256 timelock;
        bool withdrawn;
        bool refunded;
        bytes32 preimage;
    }

    mapping(bytes32 => LockContract) contracts;

    /**
     * @dev Sender sets up the hash timelock burn contract.
     * NOTE: sender must first call the approve() function on the token contract.
     * @param _burnAddress Burn Address.
     * @param _hashlock A sha-2 sha256 hash hashlock.
     * @param _timelock UNIX epoch seconds time that the lock expires at.
     *                  Refunds can be made after this time.
     * @param _tokenContract ERC20 Token contract address.
     * @param _amount Amount of the token to lock up.
     * @return contractId Id of the new HTLC. This is needed for subsequent calls.
     */

    function exitTransaction(
        address _burnAddress,
        bytes32 _hashlock,
        uint256 _timelock,
        address _tokenContract,
        uint256 _amount
    ) external returns (bytes32 contractId) {
        require(_amount > 0, "token amount must be > 0");
        require(
            ERC20(_tokenContract).allowance(msg.sender, address(this)) >=
                _amount,
            "token allowance must be >= amount"
        );
        require(_timelock > now, "timelock time must be in the future");

        contractId = sha256(
            abi.encodePacked(
                msg.sender,
                _burnAddress,
                _tokenContract,
                _amount,
                _hashlock,
                _timelock
            )
        );

        // Reject if a contract already exists with the same parameters. The
        // sender must change one of these parameters (ideally providing a
        // different _hashlock).
        if (haveContract(contractId)) revert("Contract already exists");

        // burn the token to a burn address
        if (
            !ERC20(_tokenContract).transferFrom(
                msg.sender,
                _burnAddress,
                _amount
            )
        ) revert("transferFrom sender to this failed");

        contracts[contractId] = LockContract(
            msg.sender,
            _burnAddress,
            _tokenContract,
            _amount,
            _hashlock,
            _timelock,
            false,
            false,
            0x0
        );

        emit HTLCERC20New(
            contractId,
            msg.sender,
            _burnAddress,
            _tokenContract,
            _amount,
            _hashlock,
            _timelock
        );
    }

    /**
     * @dev Add the contract details on the other chain.
     * @param _contractId HTLC contract id
     * @param _burnAddress Receiver of the tokens.
     * @param _hashlock A sha-2 sha256 hash hashlock.
     * @param _timelock UNIX epoch seconds time that the lock expires at.
     *                  Refunds can be made after this time.
     * @param _tokenContract ERC20 Token contract address.
     * @param _amount Amount of the token to lock up.
     */
    function add(
        bytes32 _contractId,
        // address _contractAddress,
        address _burnAddress,
        bytes32 _hashlock,
        uint256 _timelock,
        address _tokenContract,
        uint256 _amount
    ) external {
        contracts[_contractId] = LockContract(
            msg.sender,
            _burnAddress,
            _tokenContract,
            _amount,
            _hashlock,
            _timelock,
            false,
            false,
            0x0
        );
    }

    /**
     * @dev Called by the receiver once they know the preimage of the hashlock.
     * This will transfer ownership of the locked tokens to their address.
     *
     * @param _contractId Id of the HTLC.
     * @param _preimage sha256(_preimage) should equal the contract hashlock.
     * @return bool true on success
     */
    function entryTransaction(
        uint256 _amount,
        address _receiver,
        bytes32 _contractId,
        bytes32 _preimage
    ) external returns (bool) {
        require(haveContract(_contractId), "contractId does not exist");
        require(
            contracts[_contractId].hashlock ==
                sha256(abi.encodePacked(_preimage)),
            "hashlock hash does not match"
        );
        require(
            contracts[_contractId].withdrawn == false,
            "withdrawable: already withdrawn"
        );
        require(
            contracts[_contractId].timelock > now,
            "withdrawable: timelock time must be in the future"
        );

        LockContract storage c = contracts[_contractId];
        c.preimage = _preimage;
        c.withdrawn = true;
        if (!ERC20(c.tokenContract).transfer(_receiver, _amount))
            revert("transferFrom sender to this failed");
        emit HTLCERC20Withdraw(_contractId);
        return true;
    }

    /**
     * @dev Update the contract details.
     * @param _contractId HTLC contract id
     * @param _preimage sha256(_preimage) should equal the contract hashlock.
     */
    function update(bytes32 _contractId, bytes32 _preimage) external {
        LockContract storage c = contracts[_contractId];
        c.preimage = _preimage;
        c.withdrawn = true;
    }

    /**
     * @dev Called by the sender if there was no withdraw AND the time lock has
     * expired. This will restore ownership of the tokens to the sender.
     *
     * @param _contractId Id of HTLC to refund from.
     * @return bool true on success
     */
    function reclaimTransaction(bytes32 _contractId) external returns (bool) {
        require(haveContract(_contractId), "contractId does not exist");
        require(
            contracts[_contractId].sender == msg.sender,
            "refundable: not sender"
        );
        require(
            contracts[_contractId].refunded == false,
            "refundable: already refunded"
        );
        require(
            contracts[_contractId].withdrawn == false,
            "refundable: already withdrawn"
        );
        require(
            contracts[_contractId].timelock <= now,
            "refundable: timelock not yet passed"
        );
        LockContract storage c = contracts[_contractId];
        c.refunded = true;
        if (!ERC20(c.tokenContract).transfer(c.sender, c.amount))
            revert("transferFrom sender to this failed");
        emit HTLCERC20Refund(_contractId);
        return true;
    }

    /**
     * @dev Get contract details.
     * @param _contractId HTLC contract id
     * @return All parameters in struct LockContract for _contractId HTLC
     */
    function getContract(bytes32 _contractId)
        public
        view
        returns (
            address sender,
            address receiver,
            address tokenContract,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            bool withdrawn,
            bool refunded,
            bytes32 preimage
        )
    {
        if (haveContract(_contractId) == false)
            return (
                address(0),
                address(0),
                address(0),
                0,
                0,
                0,
                false,
                false,
                0
            );
        LockContract storage c = contracts[_contractId];
        return (
            c.sender,
            c.receiver,
            c.tokenContract,
            c.amount,
            c.hashlock,
            c.timelock,
            c.withdrawn,
            c.refunded,
            c.preimage
        );
    }

    /**
     * @dev Is there a contract with id _contractId.
     * @param _contractId Id into contracts mapping.
     */
    function haveContract(bytes32 _contractId)
        internal
        view
        returns (bool exists)
    {
        exists = (contracts[_contractId].sender != address(0));
    }
}
