const { assertEqualBN } = require('./helper/assert')
const {
  bufToStr,
  htlcERC20ArrayToObj,
  isSha256Hash,
  newSecretHashPair,
  nowSeconds,
  random32,
  txContractId,
  txLoggedArgs,
} = require('./helper/utils')

const BurnToClaim = artifacts.require('./BurnToClaim.sol')
const GriffithEC20 = artifacts.require('./helper/GriffithToken.sol')

const REQUIRE_FAILED_MSG = 'Returned error: VM Exception while processing transaction: revert'

// some testing data
const hourSeconds = 3600
const timeLock1Hour = nowSeconds() + hourSeconds
const tokenAmount = 5

contract('Cross-Blockchain test', accounts => {
  const sender = accounts[1]
  const receiver = accounts[2]
  const burnAddress = accounts[3]
  const tokenSupply = 1000
  const initialBalance = 100
  const test = 101

  let burnToClaim, token, sourceChain, destinationChain

  beforeEach(async () => {
    await await setupContracts(initialBalance);
  });

  const setupContracts = async (_initialBalance) => {
    burnToClaim = await BurnToClaim.new()
    sourceChain = await BurnToClaim.new()
    destinationChain = await BurnToClaim.new()
     // have the total supply
    token = await GriffithEC20.new(tokenSupply)
    // transfer initialBalances
    await token.transfer(sender, _initialBalance)
    await assertTokenBal(
      sender, _initialBalance, 'Initial balance not transferred to sender'
    )
    await token.transfer(burnToClaim.address, _initialBalance)
    await assertTokenBal(
      burnToClaim.address, _initialBalance, 'Initial balance not transferred to this contract'
    )
    await token.transfer(sourceChain.address, _initialBalance)
    await assertTokenBal(
      sourceChain.address, _initialBalance, 'Initial balance not transferred to sender'
    )
    await token.transfer(destinationChain.address, _initialBalance)
    await assertTokenBal(
        destinationChain.address, _initialBalance, 'Initial balance not transferred to sender'
      )
   };
   describe('Unit test scenario 1 - check balance', function () {
    it('Account[1] - Sender 100, account[2] - Receiver 0, account[3] - BurnAddress 0, this.Contract - 100 ', async () => {
      // Check sender token balance after purchase
      let senderBalance = await token.balanceOf(sender)
      console.log("Sender Balance = " + senderBalance.toString())
      let receiverBalance = await token.balanceOf(receiver)
      console.log("Receiver Balance = " + receiverBalance.toString())
      let burnAddressBalance = await token.balanceOf(burnAddress)
      console.log("BurnAddress Balance = " + burnAddressBalance.toString())
      let _destinationChain = await token.balanceOf(destinationChain.address)
      console.log("Destination chain contract Balance = " + _destinationChain.toString())
      let _sourceChain = await token.balanceOf(sourceChain.address)
      console.log("Source chain contract Balance = " + _sourceChain.toString())
    })
  })
  describe('Unit test scenario 2 - burn and claim on the same chain', function () {
    it('make a exitTransaction and after timelock expiry make a reclaimTransaction', async () => {
      const hashPair = newSecretHashPair()
      const curBlock = await web3.eth.getBlock('latest')
      const timelock2Seconds = curBlock.timestamp + 2
      await token.approve(burnToClaim.address, tokenAmount, { from: sender })
      const newContractTx = await burnToClaim.exitTransaction(
        burnAddress,
        hashPair.hash,
        timelock2Seconds,
        token.address,
        tokenAmount,
        {
          from: sender,
        }
      )

      const contractId = txContractId(newContractTx)
      // wait one second so we move past the timelock time
      return new Promise((resolve, reject) =>
        setTimeout(async () => {
          try {
            // attempt to get the refund now we've moved past the timelock time
            const balBefore = await token.balanceOf(sender)
            await burnToClaim.reclaimTransaction(contractId, { from: sender })

            // Check tokens returned to the sender
            await assertTokenBal(
              sender,
              balBefore.add(web3.utils.toBN(tokenAmount)),
              `sender balance unexpected`
            )

            const contractArr = await burnToClaim.getContract.call(contractId)
            const contract = htlcERC20ArrayToObj(contractArr)
            assert.isTrue(contract.refunded)
            assert.isFalse(contract.withdrawn)
            resolve()
          } catch (err) {
            reject(err)
          }
        }, 2000)
      )
    })
  })// end Test Scenario 1  

  describe('Unit Test scenario 3 - burn and claim on differnet contract', function () {
    it('burn on source chain and reclaim on destination chain', async () => {
      const hashPair = newSecretHashPair()
      const curBlock = await web3.eth.getBlock('latest')
      const timelock2Seconds = curBlock.timestamp + 2
      // burn on source chian
      await token.approve(sourceChain.address, tokenAmount, { from: sender })
      const sourceChainContractTx = await sourceChain.exitTransaction(
        // testContract_1.address,
        burnAddress,
        hashPair.hash,
        timelock2Seconds,
        token.address,
        tokenAmount,
        {
          from: sender,
        }
      )
      const contractId = txContractId(sourceChainContractTx)
      // update the details on the destination chain
      const destinationChainContractTx = await destinationChain.add(
        contractId,
        burnAddress,
        hashPair.hash,
        timelock2Seconds,
        token.address,
        tokenAmount,
        {
          from: sender,
        }
      )

      // update the database on source chian
      await sourceChain.update(
        contractId,
        hashPair.secret,
        {
          from: receiver
        }
      );

      // receiver calls entryTransaction with the secret to claim the tokens
      await destinationChain.entryTransaction(
        tokenAmount,
        receiver,
        contractId,
        hashPair.secret, {
        from: receiver,
      })

      // Check tokens now owned by the receiver
      await assertTokenBal(
        receiver,
        tokenAmount,
        `receiver doesn't own ${tokenAmount} tokens`
      )

      const contractArr = await destinationChain.getContract.call(contractId)
      const contract = htlcERC20ArrayToObj(contractArr)
      assert.isTrue(contract.withdrawn) // withdrawn set
      assert.isFalse(contract.refunded) // refunded still false
      assert.equal(contract.preimage, hashPair.secret)
    })
   }); // end of unit test 3

  // helper to convert the token to wei 
  function Tokens(n) {
    return web3.utils.toWei(n, 'ether');
  }

  // Helper for newContract() calls, does the ERC20 approve before calling
  const exitTransaction = async ({
    timelock = timeLock1Hour,
    hashlock = newSecretHashPair().hash,
  } = {}) => {
    await token.approve(burnToClaim.address, tokenAmount, { from: sender })
    return burnToClaim.exitTransaction(
      burnAddress, // was receiver
      hashlock,
      timelock,
      token.address,
      tokenAmount,
      {
        from: sender,
      }
    )
  }

  // helper
  const assertTokenBal = async (addr, tokenAmount, msg) =>
    assertEqualBN(
      await token.balanceOf.call(addr),
      tokenAmount,
      msg ? msg : 'wrong token balance'
    )

  // Helper for newContract() when expecting failure

  const newContractExpectFailure = async (
    shouldFailMsg,
    {
      receiverAddr = burnAddress, // was receiver
      amount = tokenAmount,
      timelock = timeLock1Hour,
      hashlock = newSecretHashPair().hash
    } = {}
  ) => {
    try {
      await burnToClaim.exitTransaction(
        receiverAddr,
        hashlock,
        timelock,
        token.address,
        amount,
        {
          from: sender,
        }
      )
      assert.fail(shouldFailMsg)
    } catch (err) {
      assert.isTrue(err.message.startsWith(REQUIRE_FAILED_MSG))
    }
  }
})
