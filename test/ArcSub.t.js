const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const U = n => ethers.parseUnits(String(n), 6);          // USDC has 6 decimals
const DAY = 86400;
const jump = async s => { await network.provider.send('evm_increaseTime', [s]); await network.provider.send('evm_mine'); };
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;

describe('ArcSub', function () {
  let usdc, sub, subAddr, merchant, subscriber, other;

  beforeEach(async () => {
    [subscriber, merchant, other] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory('MockERC20')).deploy('USD Coin', 'USDC');
    sub = await (await ethers.getContractFactory('ArcSub')).deploy(await usdc.getAddress());
    subAddr = await sub.getAddress();
    await usdc.mint(subscriber.address, U(1000));
    await usdc.connect(subscriber).approve(subAddr, ethers.MaxUint256);
  });

  describe('subscribe', () => {
    it('charges the first period immediately and schedules the next', async () => {
      await expect(sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'Pro plan'))
        .to.emit(sub, 'SubCreated').and.to.emit(sub, 'Charged');
      expect(await usdc.balanceOf(merchant.address)).to.equal(U(10));
      const s = await sub.getSub(1);
      expect(s.nextChargeAt).to.equal(BigInt(await now()) + BigInt(DAY));
      expect(s.active).to.equal(true);
      expect(s.label).to.equal('Pro plan');
    });

    it('never takes custody — the contract holds nothing', async () => {
      await sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'x');
      expect(await usdc.balanceOf(subAddr)).to.equal(0n);
    });

    it('rejects self-subscription, zero amount, short interval and long label', async () => {
      await expect(sub.connect(subscriber).subscribe(subscriber.address, U(1), DAY, ''))
        .to.be.revertedWith('self subscription');
      await expect(sub.connect(subscriber).subscribe(merchant.address, 0, DAY, ''))
        .to.be.revertedWith('zero amount');
      await expect(sub.connect(subscriber).subscribe(merchant.address, U(1), 299, ''))
        .to.be.revertedWith('interval too short');
      await expect(sub.connect(subscriber).subscribe(merchant.address, U(1), DAY, 'x'.repeat(65)))
        .to.be.revertedWith('label too long');
      await expect(sub.connect(subscriber).subscribe(ethers.ZeroAddress, U(1), DAY, ''))
        .to.be.revertedWith('zero merchant');
    });

    it('fails cleanly when the subscriber has not approved', async () => {
      await usdc.connect(other).approve(subAddr, 0);
      await usdc.mint(other.address, U(10));
      await expect(sub.connect(other).subscribe(merchant.address, U(10), DAY, '')).to.be.reverted;
    });

    it('indexes the subscription for both parties', async () => {
      await sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'a');
      await sub.connect(subscriber).subscribe(other.address, U(5), DAY, 'b');
      expect((await sub.listBySubscriber(subscriber.address)).map(Number)).to.deep.equal([1, 2]);
      expect((await sub.listByMerchant(merchant.address)).map(Number)).to.deep.equal([1]);
    });
  });

  describe('charge', () => {
    beforeEach(async () => {
      await sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'Pro');
    });

    it('refuses before the period is due', async () => {
      await expect(sub.charge(1)).to.be.revertedWith('not due yet');
    });

    it('can be triggered by anyone once due — that is what makes it automatable', async () => {
      await jump(DAY);
      await expect(sub.connect(other).charge(1)).to.emit(sub, 'Charged');
      expect(await usdc.balanceOf(merchant.address)).to.equal(U(20));
    });

    it('does not let a single call be repeated', async () => {
      await jump(DAY);
      await sub.charge(1);
      await expect(sub.charge(1)).to.be.revertedWith('not due yet');
    });

    // The comment in the contract claims this; here is the proof.
    it('does not pile up debt when many periods were missed', async () => {
      await jump(DAY * 10);
      await sub.charge(1);
      expect(await usdc.balanceOf(merchant.address)).to.equal(U(20));   // one period, not ten
      const s = await sub.getSub(1);
      expect(s.nextChargeAt).to.equal(BigInt(await now()) + BigInt(DAY));
    });

    it('keeps the original cadence when only one period elapsed', async () => {
      const before = (await sub.getSub(1)).nextChargeAt;
      await jump(DAY);
      await sub.charge(1);
      expect((await sub.getSub(1)).nextChargeAt).to.equal(before + BigInt(DAY));
    });

    it('reverts when the subscriber revoked their approval', async () => {
      await jump(DAY);
      await usdc.connect(subscriber).approve(subAddr, 0);
      await expect(sub.charge(1)).to.be.reverted;
    });

    it('refuses a cancelled subscription', async () => {
      await sub.connect(subscriber).cancel(1);
      await jump(DAY);
      await expect(sub.charge(1)).to.be.revertedWith('inactive');
    });
  });

  describe('chargeMany', () => {
    beforeEach(async () => {
      await sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'a');
      await sub.connect(subscriber).subscribe(merchant.address, U(20), DAY, 'b');
      await usdc.mint(other.address, U(1000));
      await usdc.connect(other).approve(subAddr, ethers.MaxUint256);
      await sub.connect(other).subscribe(merchant.address, U(30), DAY, 'c');
    });

    // Fixed: a failure no longer vanishes — each skipped due charge is reported.
    it('charges what it can and reports what it skipped', async () => {
      await jump(DAY);
      await usdc.connect(other).approve(subAddr, 0);       // #3 will now fail
      const before = await usdc.balanceOf(merchant.address);

      await expect(sub.chargeMany([1, 2, 3])).to.emit(sub, 'ChargeSkipped').withArgs(3);

      expect(await usdc.balanceOf(merchant.address) - before).to.equal(U(30)); // 10 + 20, not 60
      expect((await sub.getSub(3)).nextChargeAt).to.be.lessThanOrEqual(await now()); // still due
    });

    it('the schedules are the only way to tell who actually paid', async () => {
      await jump(DAY);
      await usdc.connect(other).approve(subAddr, 0);
      const before = [1, 2, 3].map(async i => (await sub.getSub(i)).nextChargeAt);
      const b = await Promise.all(before);
      await sub.chargeMany([1, 2, 3]);
      const a = await Promise.all([1, 2, 3].map(async i => (await sub.getSub(i)).nextChargeAt));
      expect(a[0] > b[0]).to.equal(true);
      expect(a[1] > b[1]).to.equal(true);
      expect(a[2] === b[2]).to.equal(true);    // untouched — this is what the UI now reports
    });

    it('skips subscriptions that are not due, without reporting them as failures', async () => {
      const before = await usdc.balanceOf(merchant.address);
      await expect(sub.chargeMany([1, 2, 3])).to.not.emit(sub, 'ChargeSkipped');
      expect(await usdc.balanceOf(merchant.address)).to.equal(before);
    });
  });

  describe('cancel', () => {
    beforeEach(async () => {
      await sub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'Pro');
    });

    it('can be done by the subscriber', async () => {
      await expect(sub.connect(subscriber).cancel(1)).to.emit(sub, 'Cancelled').withArgs(1, subscriber.address);
      expect((await sub.getSub(1)).active).to.equal(false);
    });

    it('can be done by the merchant', async () => {
      await expect(sub.connect(merchant).cancel(1)).to.emit(sub, 'Cancelled').withArgs(1, merchant.address);
    });

    it('cannot be done by a stranger', async () => {
      await expect(sub.connect(other).cancel(1)).to.be.revertedWith('not a party');
    });

    it('cannot be repeated', async () => {
      await sub.connect(subscriber).cancel(1);
      await expect(sub.connect(subscriber).cancel(1)).to.be.revertedWith('already inactive');
    });
  });

  describe('hostile token', () => {
    // nextCharge advances before transferFrom, so a re-entering token is stopped
    // by the "not due yet" guard rather than double-charging.
    it('cannot be double-charged by a token that re-enters', async () => {
      const evil = await (await ethers.getContractFactory('ReentrantToken')).deploy();
      const evilSub = await (await ethers.getContractFactory('ArcSub')).deploy(await evil.getAddress());
      const evilSubAddr = await evilSub.getAddress();
      await evil.mint(subscriber.address, U(1000));
      await evil.connect(subscriber).approve(evilSubAddr, ethers.MaxUint256);

      await evilSub.connect(subscriber).subscribe(merchant.address, U(10), DAY, 'x');
      await evil.arm(evilSubAddr, 1);
      await jump(DAY);

      const before = await evil.balanceOf(merchant.address);
      await evilSub.charge(1);
      expect(await evil.balanceOf(merchant.address) - before).to.equal(U(10));  // once, not twice
    });
  });

  describe('the approval a subscriber grants', () => {
    // Only msg.sender can subscribe themselves, which is what bounds an
    // unlimited approval to this contract.
    it('cannot be spent by a subscription somebody else created', async () => {
      await expect(
        sub.connect(other).subscribe(other.address, U(10), DAY, 'steal')
      ).to.be.revertedWith('self subscription');
      // and there is no entry point that names an arbitrary subscriber
      expect(sub.interface.fragments.filter(f =>
        f.type === 'function' && f.inputs.some(i => i.name === 'subscriber')).length).to.equal(0);
    });
  });
});
