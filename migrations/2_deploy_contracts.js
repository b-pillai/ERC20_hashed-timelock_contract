const HashedTimelockERC20 = artifacts.require('./HashedTimelockERC20.sol')
const BurnToClaim = artifacts.require('./BurnToClaim.sol')
module.exports = async function (deployer) {
  await deployer.deploy(HashedTimelockERC20)
  await deployer.deploy(BurnToClaim)
    }
