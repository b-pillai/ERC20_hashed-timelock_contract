const {assertEqualBN} = require('./helper/assert')
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
const AliceERC20 = artifacts.require('./helper/AliceERC20.sol')

const REQUIRE_FAILED_MSG = 'Returned error: VM Exception while processing transaction: revert'

// some testing data
const hourSeconds = 3600
const timeLock1Hour = nowSeconds() + hourSeconds
const tokenAmount = 5

contract('Burn-To-Claim', accounts => {
  const sender = accounts[1]
  const receiver = accounts[2]
  const burnAddress = accounts[3]
  const tokenSupply = 1000
  const senderInitialBalance = 100

  let burnToClaim
  let token

  const assertTokenBal = async (addr, tokenAmount, msg) =>
    assertEqualBN(
      await token.balanceOf.call(addr),
      tokenAmount,
      msg ? msg : 'wrong token balance'
    )

  before(async () => {
    burnToClaim = await BurnToClaim.new()
    token = await AliceERC20.new(tokenSupply)
    await token.transfer(sender, senderInitialBalance)
    await assertTokenBal(
      sender,
      senderInitialBalance,
      'balance not transferred in before()'
    )
    await token.transfer(burnToClaim.address, senderInitialBalance)
    await assertTokenBal(
      burnToClaim.address,
      senderInitialBalance,
      'balance not transferred in burn address contract()'
    )
  })

  it('exitTransaction() should create new contract and store correct details', async () => {
    const hashPair = newSecretHashPair()
    const newContractTx = await exitTransaction({
      hashlock: hashPair.hash,
    })

    // check token balances
    assertTokenBal(sender, senderInitialBalance - tokenAmount)
   // assertTokenBal(burnToClaim.address, tokenAmount)
    assertTokenBal(burnAddress, tokenAmount)

    // check event logs
    const logArgs = txLoggedArgs(newContractTx)

    const contractId = logArgs.contractId
    assert(isSha256Hash(contractId))

    assert.equal(logArgs.sender, sender)
    assert.equal(logArgs.receiver, burnAddress) // was receiver
    assert.equal(logArgs.tokenContract, token.address)
    assert.equal(logArgs.amount.toNumber(), tokenAmount)
    assert.equal(logArgs.hashlock, hashPair.hash)
    assert.equal(logArgs.timelock, timeLock1Hour)

    // check htlc record
    const contractArr = await burnToClaim.getContract.call(contractId)
    const contract = htlcERC20ArrayToObj(contractArr)
    assert.equal(contract.sender, sender)
    assert.equal(contract.receiver, burnAddress) // was receiver
    assert.equal(contract.token, token.address)
    assert.equal(contract.amount.toNumber(), tokenAmount)
    assert.equal(contract.hashlock, hashPair.hash)
    assert.equal(contract.timelock.toNumber(), timeLock1Hour)
    assert.isFalse(contract.withdrawn)
    assert.isFalse(contract.refunded)
    assert.equal(
      contract.preimage,
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    )
    })

  it('exitTransaction() should fail when no token transfer approved', async () => {
    await token.approve(burnToClaim.address, 0, {from: sender}) // ensure 0
    await newContractExpectFailure('expected failure due to no tokens approved')
  })

  it('exitTransaction() should fail when token amount is 0', async () => {
    // approve htlc for one token but send amount as 0
    await token.approve(burnToClaim.address, 1, {from: sender})
    await newContractExpectFailure('expected failure due to 0 token amount', {
      amount: 0,
    })
  })

  it('exitTransaction() should fail when tokens approved for some random account', async () => {
    // approve htlc for different account to the htlc contract
    await token.approve(burnToClaim.address, 0, {from: sender}) // ensure 0
    await token.approve(accounts[9], tokenAmount, {from: sender})
    await newContractExpectFailure('expected failure due to wrong approval')
  })

  it('exitTransaction() should fail when the timelock is in the past', async () => {
    const pastTimelock = nowSeconds() - 2
    await token.approve(burnToClaim.address, tokenAmount, {from: sender})
    await newContractExpectFailure(
      'expected failure due to timelock in the past',
      {timelock: pastTimelock}
    )
  })

  it('exitTransaction() should reject a duplicate contract request', async () => {
    const hashlock = newSecretHashPair().hash
    const timelock = timeLock1Hour + 5
    const balBefore = web3.utils.toBN(await token.balanceOf(burnAddress))

    await exitTransaction({hashlock: hashlock, timelock: timelock})
    await assertTokenBal(
      burnAddress,
      balBefore.add(web3.utils.toBN(tokenAmount)),
      'tokens not transfered to burn address'
    )

    await token.approve(burnToClaim.address, tokenAmount, {from: sender})
    // now attempt to create another with the exact same parameters
    await newContractExpectFailure(
      'expected failure due to duplicate contract details',
      {
        timelock: timelock,
        hashlock: hashlock,
      }
    )
  })

  it('entryTransaction() should send receiver funds when given the correct secret preimage', async () => {
    const hashPair = newSecretHashPair()
    const newContractTx = await exitTransaction({hashlock: hashPair.hash})
    const contractId = txContractId(newContractTx)

    // receiver calls withdraw with the secret to claim the tokens
    await burnToClaim.entryTransaction(tokenAmount, receiver, contractId, hashPair.secret, {
      from: receiver,
    })

    // Check tokens now owned by the receiver
    await assertTokenBal(
      receiver,
      tokenAmount,
      `receiver doesn't own ${tokenAmount} tokens`
    )

    const contractArr = await burnToClaim.getContract.call(contractId)
    const contract = htlcERC20ArrayToObj(contractArr)
    assert.isTrue(contract.withdrawn) // withdrawn set
    assert.isFalse(contract.refunded) // refunded still false
    assert.equal(contract.preimage, hashPair.secret)
  })

  it('entryTransaction() should fail if preimage does not hash to hashX', async () => {
    const newContractTx = await exitTransaction({})
    const contractId = txContractId(newContractTx)

    // receiver calls withdraw with an invalid secret
    const wrongSecret = bufToStr(random32())
    try {
      await burnToClaim.entryTransaction(tokenAmount, receiver, contractId, wrongSecret, {from: receiver})
      assert.fail('expected failure due to 0 value transferred')
    } catch (err) {
      assert.isTrue(err.message.startsWith(REQUIRE_FAILED_MSG))
    }
  })

// this part need some work - babu
 // it('withdraw() should fail if caller is not the receiver ', async () => {
 //  const hashPair = newSecretHashPair()
 //   await token.approve(burnToClaim.address, tokenAmount, {from: sender})
 //   const newContractTx = await exitTransaction({
 //     hashlock: hashPair.hash,
 //   })
 //   const contractId = txContractId(newContractTx)
 //   const someGuy = accounts[4]
 //   try {
 //     await burnToClaim.entryTransaction(tokenAmount, receiver, contractId, hashPair.secret, {from: someGuy})
 //     assert.fail('expected failure due to wrong receiver')
 //   } catch (err) {
 //     assert.isTrue(err.message.startsWith(REQUIRE_FAILED_MSG))
 //   }
 // })

  

   it('entryTransaction() should fail after timelock expiry', async () => {
     const hashPair = newSecretHashPair()
     const curBlock = await web3.eth.getBlock('latest')
     const timelock2Seconds = curBlock.timestamp + 2

     const newContractTx = await exitTransaction({
       hashlock: hashPair.hash,
       timelock: timelock2Seconds,
     })
     const contractId = txContractId(newContractTx)

     // wait one second so we move past the timelock time
     return new Promise((resolve, reject) => {
       setTimeout(async () => {
         // attempt to withdraw and check that it is not allowed
         try {
           await burnToClaim.entryTransaction(tokenAmount, receiver, contractId, hashPair.secret, {from: receiver})
           reject(
             new Error('expected failure due to withdraw after timelock expired')
           )
         } catch (err) {
           assert.isTrue(err.message.startsWith(REQUIRE_FAILED_MSG))
           resolve({message: 'success'})
         }
       }, 2000)
     })
   })


  it('reclaimTransaction() should pass after timelock expiry', async () => {
    const hashPair = newSecretHashPair()
    const curBlock = await web3.eth.getBlock('latest')
    const timelock2Seconds = curBlock.timestamp + 2

    await token.approve(burnToClaim.address, tokenAmount, {from: sender})
    const newContractTx = await exitTransaction({
      timelock: timelock2Seconds,
      hashlock: hashPair.hash,
    })
    const contractId = txContractId(newContractTx)

    // wait one second so we move past the timelock time
    return new Promise((resolve, reject) =>
      setTimeout(async () => {
        try {
          // attempt to get the refund now we've moved past the timelock time
          const balBefore = await token.balanceOf(sender)
          await burnToClaim.reclaimTransaction(contractId, {from: sender})

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

  
  it('reclaimTransaction() should fail before the timelock expiry', async () => {
    const newContractTx = await exitTransaction()
    const contractId = txContractId(newContractTx)
    try {
      await burnToClaim.reclaimTransaction(contractId, {from: sender})
      assert.fail('expected failure due to timelock')
    } catch (err) {
      assert.isTrue(err.message.startsWith(REQUIRE_FAILED_MSG))
    }
  })

  it("getContract() returns empty record when contract doesn't exist", async () => {
    const burnToClaim = await BurnToClaim.deployed()
    const contract = await burnToClaim.getContract.call('0xabcdef')
    const sender = contract[0]
    assert.equal(Number(sender), 0)
  })


// Helper for newContract() calls, does the ERC20 approve before calling
  
  const exitTransaction = async ({
                               timelock = timeLock1Hour,
                               hashlock = newSecretHashPair().hash,
                             } = {}) => {
    await token.approve(burnToClaim.address, tokenAmount, {from: sender})
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
