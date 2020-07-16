const BurnToClaim = artifacts.require('./BurnToClaim.sol')
module.exports = function (deployer) {
  deployer.deploy(BurnToClaim)
    }
