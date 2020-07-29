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
 *  2) entryTransaction(transactionId, preimage) - once the receiver knows the preimage of
 *     the hashlock hash they can claim the tokens with this function, with in the timelock.
 *  3) reclaimTransaction(transactionId) - after timelock has expired and if the receiver did not
 *     withdraw the tokens the sender can get their tokens back with this function.
 */
contract BurnToClaim {
    event exitTransactionEvent(
        bytes32 indexed transactionId,
        address indexed sender,
        address indexed receiver,
        address tokenContract,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event entryTransactionEvent(bytes32 indexed transactionId);
    event reclaimTransactionEvent(bytes32 indexed transactionId);

    struct BurnTokenData {
        address sender;
        address receiver;
        //  address crossChainContract; // contract address of the crossChians
        address tokenContract; // Base token contract address
        uint256 amount;
        bytes32 hashlock;
        // locked UNTIL this time. Unit depends on consensus algorithm.
        // PoA, PoA and IBFT all use seconds. But Quorum Raft uses nano-seconds
        uint256 timelock;
        bool withdrawn;
        bool refunded;
        bytes32 preimage;
    }
    // burned tokens data
    mapping(bytes32 => BurnTokenData) burnTokenData;

    struct CrosschainAddress {
        address contractAddress;
        bool isExit;
    }
    // address of the other participating crossBlockchain contracts
    mapping(address => CrosschainAddress) crosschainAddress;

    function registerContract(address contractAddress) external {
        require(
            contractAddress != address(0),
            "contract address must not be zero address"
        );
        crosschainAddress[contractAddress] = CrosschainAddress(
            contractAddress,
            true
        );
    }

    /**
     * @dev Sender sets up the hash timelock burn contract.
     * NOTE: sender must first call the approve() function on the token contract.
     * @param _burnAddress Burn Address.
     * @param _hashlock A sha-2 sha256 hash hashlock.
     * @param _timelock UNIX epoch seconds time that the lock expires at.
     *                  Refunds can be made after this time.
     * @param _tokenContract ERC20 Token contract address.
     * @param _amount Amount of the token to lock up.
     * @return transactionId Id of the new HTLC. This is needed for subsequent calls.
     */

    function exitTransaction(
        //  address _recipentContractAddress,
        address _burnAddress,
        bytes32 _hashlock,
        uint256 _timelock,
        address _tokenContract,
        uint256 _amount
    ) external returns (bytes32 transactionId) {
        require(_amount > 0, "token amount must be > 0");
        require(
            ERC20(_tokenContract).allowance(msg.sender, address(this)) >=
                _amount,
            "token allowance must be >= amount"
        );
        require(_timelock > now, "timelock time must be in the future");

        transactionId = sha256(
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
        if (haveContract(transactionId)) revert("Contract already exists");

        // burn the token to a burn address
        if (
            !ERC20(_tokenContract).transferFrom(
                msg.sender,
                _burnAddress,
                _amount
            )
        ) revert("transferFrom sender to this failed");

        burnTokenData[transactionId] = BurnTokenData(
            msg.sender,
            _burnAddress,
            //  _recipentContractAddress,
            _tokenContract,
            _amount,
            _hashlock,
            _timelock,
            false,
            false,
            0x0
        );

        emit exitTransactionEvent(
            transactionId,
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
     * @param _transactionId the burn transaction id
     * @param _burnAddress Receiver of the tokens
     * @param _hashlock A sha-2 sha256 hash of the secreat key.
     * @param _timelock UNIX epoch seconds time that the lock expires at.
     *                  Refunds can be made after this time.
     * @param _tokenContract ERC20 Token contract address.
     * @param _amount Amount of the token to lock up.
     */
    function add(
        address _crosschainContractAddress,
        bytes32 _transactionId,
        address _burnAddress,
        bytes32 _hashlock,
        uint256 _timelock,
        address _tokenContract, // base token contract
        uint256 _amount
    ) external {
        require(
            crosschainAddress[_crosschainContractAddress].isExit,
            "Add corssChain data contract address not exit"
        );
        burnTokenData[_transactionId] = BurnTokenData(
            msg.sender,
            _burnAddress,
            //  _recipentContractAddress,
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
     * @param _transactionId Id of the HTLC.
     * @param _preimage sha256(_preimage) should equal the contract hashlock.
     * @return bool true on success
     */
    function entryTransaction(
        //  address _recipentContractAddress,
        uint256 _amount,
        address _receiver,
        bytes32 _transactionId,
        bytes32 _preimage
    ) external returns (bool) {
        require(haveContract(_transactionId), "transactionId does not exist");
        require(
            burnTokenData[_transactionId].hashlock ==
                sha256(abi.encodePacked(_preimage)),
            "hashlock hash does not match"
        );
        require(
            burnTokenData[_transactionId].withdrawn == false,
            "withdrawable: already withdrawn"
        );
        require(
            burnTokenData[_transactionId].timelock > now,
            "withdrawable: timelock time must be in the future"
        );

        BurnTokenData storage c = burnTokenData[_transactionId];
        c.preimage = _preimage;
        c.withdrawn = true;
        if (!ERC20(c.tokenContract).transfer(_receiver, _amount))
            revert("transferFrom sender to this failed");
        emit entryTransactionEvent(_transactionId);
        return true;
    }

    /**
     * @dev Update the contract details.
     * @param _transactionId HTLC contract id
     * @param _preimage sha256(_preimage) should equal the contract hashlock.
     */
    function update(address _crosschainContractAddress, bytes32 _transactionId, bytes32 _preimage) external {
        require(
            crosschainAddress[_crosschainContractAddress].isExit,
            "Update corssChain data contract address not exit"
        );
        BurnTokenData storage c = burnTokenData[_transactionId];
        c.preimage = _preimage;
        c.withdrawn = true;
    }

    /**
     * @dev Called by the sender if there was no withdraw AND the time lock has
     * expired. This will restore ownership of the tokens to the sender.
     *
     * @param _transactionId Id of HTLC to refund from.
     * @return bool true on success
     */
    function reclaimTransaction(bytes32 _transactionId)
        external
        returns (bool)
    {
        require(haveContract(_transactionId), "transactionId does not exist");
        require(
            burnTokenData[_transactionId].sender == msg.sender,
            "refundable: not sender"
        );
        require(
            burnTokenData[_transactionId].refunded == false,
            "refundable: already refunded"
        );
        require(
            burnTokenData[_transactionId].withdrawn == false,
            "refundable: already withdrawn"
        );
        require(
            burnTokenData[_transactionId].timelock <= now,
            "refundable: timelock not yet passed"
        );

        BurnTokenData storage c = burnTokenData[_transactionId];
        c.refunded = true;
        if (!ERC20(c.tokenContract).transfer(c.sender, c.amount))
            revert("transferFrom sender to this failed");
        emit reclaimTransactionEvent(_transactionId);
        return true;
    }

    /**
     * @dev Get contract details.
     * @param _transactionId HTLC contract id
     * @return All parameters in struct LockContract for _transactionId HTLC
     */
    function getContract(bytes32 _transactionId)
        public
        view
        returns (
            address sender,
            address receiver,
            //  address crossChainContract,
            address tokenContract,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            bool withdrawn,
            bool refunded,
            bytes32 preimage
        )
    {
        if (haveContract(_transactionId) == false)
            return (
                address(0),
                address(0),
                //   address(0),
                address(0),
                0,
                0,
                0,
                false,
                false,
                0
            );
        BurnTokenData storage c = burnTokenData[_transactionId];
        return (
            c.sender,
            c.receiver,
            //  c.crossChainContract,
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
     * @dev Is there a contract with id _transactionId.
     * @param _transactionId Id into contracts mapping.
     */
    function haveContract(bytes32 _transactionId)
        internal
        view
        returns (bool exists)
    {
        exists = (burnTokenData[_transactionId].sender != address(0));
    }
}
