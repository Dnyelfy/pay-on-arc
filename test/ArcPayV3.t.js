const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const E = n => ethers.parseEther(String(n));
const DAY = 86400;
const jump = async s => { await network.provider.send('evm_increaseTime', [s]); await network.provider.send('evm_mine'); };

describe('ArcPayV3', function () {
  let pay, alice, bob, carol;

  beforeEach(async () => {
    [alice, bob, carol] = await ethers.getSigners();
    pay = await (await ethers.getContractFactory('ArcPayV3')).deploy();
  });

  describe('pay', () => {
    it('forwards the whole amount and records the note', async () => {
      const before = await ethers.provider.getBalance(bob.address);
      await expect(pay.connect(alice).pay(bob.address, 'coffee', { value: E(1) }))
        .to.emit(pay, 'PaymentSent').withArgs(alice.address, bob.address, E(1), 'coffee');
      expect(await ethers.provider.getBalance(bob.address) - before).to.equal(E(1));
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });

    it('rejects a zero amount', async () => {
      await expect(pay.pay(bob.address, '', { value: 0 })).to.be.revertedWith('zero amount');
    });
  });

  describe('splitPay', () => {
    it('splits equally and returns the rounding dust to the sender', async () => {
      const b0 = await ethers.provider.getBalance(bob.address);
      const c0 = await ethers.provider.getBalance(carol.address);
      const value = 10n;
      await pay.connect(alice).splitPay([bob.address, carol.address, alice.address], 'dinner', { value });
      const share = value / 3n;
      expect(await ethers.provider.getBalance(bob.address) - b0).to.equal(share);
      expect(await ethers.provider.getBalance(carol.address) - c0).to.equal(share);
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });

    it('emits one receipt per recipient', async () => {
      await expect(pay.splitPay([bob.address, carol.address], 'x', { value: E(2) }))
        .to.emit(pay, 'PaymentSent').withArgs(alice.address, bob.address, E(1), 'x')
        .and.to.emit(pay, 'PaymentSent').withArgs(alice.address, carol.address, E(1), 'x');
    });

    it('enforces 1..20 recipients', async () => {
      await expect(pay.splitPay([], 'x', { value: E(1) })).to.be.revertedWith('1-20 recipients');
      const many = Array(21).fill(bob.address);
      await expect(pay.splitPay(many, 'x', { value: E(21) })).to.be.revertedWith('1-20 recipients');
    });

    it('rejects a total too small to divide', async () => {
      await expect(pay.splitPay([bob.address, carol.address], 'x', { value: 1 }))
        .to.be.revertedWith('zero share');
    });

    // Fixed in V3: one refusing recipient used to revert the whole batch.
    it('pays everyone else and returns a refused share to the sender', async () => {
      const bad = await (await ethers.getContractFactory('RejectingReceiver')).deploy();
      const badAddr = await bad.getAddress();
      const c0 = await ethers.provider.getBalance(carol.address);
      await expect(pay.connect(bob).splitPay([carol.address, badAddr], 'team payout', { value: E(2) }))
        .to.emit(pay, 'PaymentSent').withArgs(bob.address, carol.address, E(1), 'team payout')
        .and.to.emit(pay, 'ShareReturned').withArgs(bob.address, badAddr, E(1));
      expect(await ethers.provider.getBalance(carol.address) - c0).to.equal(E(1));
      expect(await ethers.provider.getBalance(badAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });

    it('never strands the refund: a sender that refuses it reverts the split', async () => {
      const splitter = await (await ethers.getContractFactory('RefusingSplitter')).deploy();
      // 10 wei over two recipients leaves no dust, so the split goes through…
      await splitter.split(await pay.getAddress(), [bob.address, carol.address], { value: 10n });
      // …but 11 wei leaves 1 wei of dust the sender cannot take back.
      await expect(splitter.split(await pay.getAddress(), [bob.address, carol.address], { value: 11n }))
        .to.be.revertedWith('refund failed');
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(0n);
    });
  });

  describe('payRecallable', () => {
    it('holds the funds in the contract', async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, 'later', { value: E(1) });
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(E(1));
    });

    it('enforces the 60s–30d window', async () => {
      await expect(pay.payRecallable(bob.address, 59, '', { value: E(1) }))
        .to.be.revertedWith('60s - 30d window');
      await expect(pay.payRecallable(bob.address, 30 * DAY + 1, '', { value: E(1) }))
        .to.be.revertedWith('60s - 30d window');
    });

    it('rejects the zero address and a zero amount', async () => {
      await expect(pay.payRecallable(ethers.ZeroAddress, 3600, '', { value: E(1) }))
        .to.be.revertedWith('bad recipient');
      await expect(pay.payRecallable(bob.address, 3600, '', { value: 0 }))
        .to.be.revertedWith('zero amount');
    });

    it('indexes the payment for both parties', async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, '', { value: E(1) });
      await pay.connect(alice).payRecallable(carol.address, 3600, '', { value: E(1) });
      expect((await pay.sentBy(alice.address)).map(Number)).to.deep.equal([0, 1]);
      expect((await pay.receivedBy(bob.address)).map(Number)).to.deep.equal([0]);
      expect((await pay.receivedBy(carol.address)).map(Number)).to.deep.equal([1]);
      expect(await pay.total()).to.equal(2n);
    });
  });

  describe('the cancel window', () => {
    beforeEach(async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, 'note', { value: E(1) });
    });

    it('stops the recipient claiming inside the window', async () => {
      await expect(pay.connect(bob).claim(0)).to.be.revertedWith('still in cancel window');
    });

    it('lets the sender cancel inside the window and returns the money', async () => {
      const a0 = await ethers.provider.getBalance(alice.address);
      await expect(pay.connect(alice).recall(0)).to.emit(pay, 'Recalled').withArgs(0, alice.address, E(1));
      expect((await pay.rpays(0)).status).to.equal(2);
      expect(await ethers.provider.getBalance(alice.address) > a0).to.equal(true);
    });

    it('lets the recipient claim once the window closes', async () => {
      await jump(3601);
      await expect(pay.connect(bob).claim(0)).to.emit(pay, 'Claimed').withArgs(0, bob.address, E(1));
      expect((await pay.rpays(0)).status).to.equal(1);
    });

    it('stops the sender cancelling once the window closes', async () => {
      await jump(3601);
      await expect(pay.connect(alice).recall(0))
        .to.be.revertedWith('recipient window: cancel closed, not abandoned yet');
    });

    it('refuses a claim or a cancel from a third party', async () => {
      await expect(pay.connect(carol).recall(0)).to.be.revertedWith('not sender');
      await jump(3601);
      await expect(pay.connect(carol).claim(0)).to.be.revertedWith('not recipient');
    });

    it('cannot be claimed after a cancel, or cancelled after a claim', async () => {
      await pay.connect(alice).recall(0);
      await jump(3601);
      await expect(pay.connect(bob).claim(0)).to.be.revertedWith('not claimable');

      await pay.connect(alice).payRecallable(bob.address, 60, '', { value: E(1) });
      await jump(61);
      await pay.connect(bob).claim(1);
      await jump(31 * DAY);
      await expect(pay.connect(alice).recall(1)).to.be.revertedWith('not recallable');
    });
  });

  describe('abandoned payments', () => {
    beforeEach(async () => {
      await pay.connect(alice).payRecallable(bob.address, 3600, '', { value: E(1) });
    });

    it('stays the recipient’s for 30 days after the window', async () => {
      await jump(3600 + 29 * DAY);
      await expect(pay.connect(alice).recall(0)).to.be.reverted;
    });

    it('can be reclaimed by the sender after 30 days untouched', async () => {
      await jump(3600 + 30 * DAY + 1);
      await expect(pay.connect(alice).recall(0)).to.emit(pay, 'Recalled');
    });

    it('still belongs to a recipient who acts first', async () => {
      await jump(3600 + 31 * DAY);
      await pay.connect(bob).claim(0);
      await expect(pay.connect(alice).recall(0)).to.be.revertedWith('not recallable');
    });
  });

  describe('hostile recipients', () => {
    it('cannot be drained by a recipient that re-enters claim', async () => {
      const evil = await (await ethers.getContractFactory('ReentrantClaimer')).deploy();
      const evilAddr = await evil.getAddress();
      await pay.connect(alice).payRecallable(evilAddr, 3600, '', { value: E(1) });
      await pay.connect(alice).payRecallable(carol.address, 3600, '', { value: E(5) });
      await evil.arm(await pay.getAddress(), 0);
      await jump(3601);

      await evil.go();

      expect(await ethers.provider.getBalance(evilAddr)).to.equal(E(1));
      expect(await ethers.provider.getBalance(await pay.getAddress())).to.equal(E(5));
      expect(await evil.reentries() > 0n).to.equal(true);
    });

    it('lets the sender reclaim a payment its recipient can never accept', async () => {
      const bad = await (await ethers.getContractFactory('RejectingReceiver')).deploy();
      await pay.connect(alice).payRecallable(await bad.getAddress(), 60, '', { value: E(1) });
      await jump(61);
      await expect(pay.connect(alice).recall(0)).to.be.reverted;      // not abandoned yet
      await jump(30 * DAY + 1);
      await expect(pay.connect(alice).recall(0)).to.emit(pay, 'Recalled');
    });
  });
});
