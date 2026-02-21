/**
 * Quadratic Funding Platform for AI Agents
 * 
 * REAL PAYMENTS VERSION (ETH)
 * - Verifies ETH contributions on-chain
 * - Distributes matching pool at round end
 * - Built on Base (Chain ID: 8453)
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// BLOCKCHAIN CONFIG
// ============================================================================

const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xccD7200024A8B5708d381168ec2dB0DC587af83F';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY?.trim();

// ETH decimals
const ETH_DECIMALS = 18;

// Lazy-initialized provider and wallet
let provider = null;
let wallet = null;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(BASE_RPC);
  }
  return provider;
}

function getWallet() {
  if (!wallet && TREASURY_PRIVATE_KEY) {
    wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, getProvider());
  }
  return wallet;
}

// ============================================================================
// DATA STORAGE
// ============================================================================

const projects = new Map();
const contributions = new Map();
const rounds = new Map();
const payouts = new Map();

// ============================================================================
// HELPERS
// ============================================================================

function formatETH(wei) {
  return parseFloat(ethers.formatEther(wei.toString())).toFixed(6) + ' ETH';
}

function parseETH(ethString) {
  const cleaned = ethString.toString().replace(' ETH', '').trim();
  return ethers.parseEther(cleaned);
}

// ============================================================================
// QUADRATIC FUNDING MATH
// ============================================================================

function calculateQFMatching(roundId) {
  const round = rounds.get(roundId);
  if (!round) return null;

  const roundContribs = Array.from(contributions.values())
    .filter(c => c.roundId === roundId && c.verified);

  const projectContribs = {};
  for (const c of roundContribs) {
    if (!projectContribs[c.projectId]) {
      projectContribs[c.projectId] = [];
    }
    projectContribs[c.projectId].push(c);
  }

  const projectMatches = {};
  let totalRawMatch = 0n;

  for (const [projectId, contribs] of Object.entries(projectContribs)) {
    const contributorTotals = {};
    for (const c of contribs) {
      if (!contributorTotals[c.contributorAddress]) {
        contributorTotals[c.contributorAddress] = 0n;
      }
      contributorTotals[c.contributorAddress] += BigInt(c.amount);
    }

    // QF math with BigInt (use sqrt approximation)
    let sumSqrt = 0;
    let sumDirect = 0n;
    for (const amount of Object.values(contributorTotals)) {
      // Convert to number for sqrt (safe for reasonable contribution amounts)
      const amountNum = Number(ethers.formatEther(amount));
      sumSqrt += Math.sqrt(amountNum);
      sumDirect += amount;
    }

    const rawMatchNum = Math.pow(sumSqrt, 2) - Number(ethers.formatEther(sumDirect));
    const rawMatch = rawMatchNum > 0 ? ethers.parseEther(rawMatchNum.toFixed(18)) : 0n;
    
    projectMatches[projectId] = {
      rawMatch,
      directFunding: sumDirect,
      uniqueContributors: Object.keys(contributorTotals).length,
      contributions: contribs.length
    };
    totalRawMatch += rawMatch;
  }

  // Scale to matching pool
  const matchingPool = BigInt(round.matchingPool);
  
  const results = {};
  for (const [projectId, data] of Object.entries(projectMatches)) {
    let scaledMatch = 0n;
    if (totalRawMatch > 0n) {
      scaledMatch = (data.rawMatch * matchingPool) / totalRawMatch;
    }
    
    const totalFunding = data.directFunding + scaledMatch;
    
    results[projectId] = {
      projectId,
      directFunding: data.directFunding.toString(),
      directFundingFormatted: formatETH(data.directFunding),
      matchAmount: scaledMatch.toString(),
      matchAmountFormatted: formatETH(scaledMatch),
      totalFunding: totalFunding.toString(),
      totalFundingFormatted: formatETH(totalFunding),
      uniqueContributors: data.uniqueContributors,
      contributions: data.contributions
    };
  }

  return { roundId, matchingPool: round.matchingPool, projects: results };
}

// ============================================================================
// ON-CHAIN VERIFICATION
// ============================================================================

async function verifyETHTransfer(txHash, expectedFrom, expectedAmountWei) {
  try {
    const tx = await getProvider().getTransaction(txHash);
    if (!tx) {
      return { valid: false, error: 'Transaction not found' };
    }

    const receipt = await getProvider().getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return { valid: false, error: 'Transaction failed' };
    }

    // Check recipient is treasury
    if (tx.to?.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
      return { valid: false, error: 'Transaction not sent to treasury' };
    }

    // Check sender matches
    if (expectedFrom && tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
      return { valid: false, error: 'Sender does not match' };
    }

    // Check amount (allow >= expected)
    if (tx.value < expectedAmountWei) {
      return { valid: false, error: `Amount too low: ${formatETH(tx.value)} < ${formatETH(expectedAmountWei)}` };
    }

    return {
      valid: true,
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      amount: tx.value.toString(),
      blockNumber: receipt.blockNumber
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

async function getTreasuryBalance() {
  try {
    const balance = await getProvider().getBalance(TREASURY_ADDRESS);
    return balance;
  } catch (err) {
    console.error('[BALANCE ERROR]', err.message);
    return 0n;
  }
}

async function sendETH(toAddress, amountWei) {
  const w = getWallet();
  if (!w) {
    throw new Error('Wallet not configured');
  }

  const tx = await w.sendTransaction({
    to: toAddress,
    value: amountWei
  });
  
  // Don't wait for confirmation (serverless timeout)
  // Return immediately with tx hash
  return {
    txHash: tx.hash,
    status: 'pending'
  };
}

// ============================================================================
// API: ROUNDS
// ============================================================================


// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.post('/rounds', requireWhitelist(), async (req, res) => {
  const { name, description, matchingPool, durationDays } = req.body;

  if (!name || !matchingPool) {
    return res.status(400).json({ error: 'name and matchingPool required (e.g., "0.01" for 0.01 ETH)' });
  }

  let poolAmountWei;
  try {
    poolAmountWei = parseETH(matchingPool);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid matchingPool format. Use ETH amount like "0.01"' });
  }

  // Verify treasury has enough ETH
  const balance = await getTreasuryBalance();
  const existingCommitted = Array.from(rounds.values())
    .filter(r => r.status === 'active' || r.status === 'pending_payout')
    .reduce((sum, r) => sum + BigInt(r.matchingPool), 0n);

  if (balance < existingCommitted + poolAmountWei) {
    return res.status(400).json({
      error: 'Insufficient treasury balance',
      available: formatETH(balance - existingCommitted),
      requested: formatETH(poolAmountWei)
    });
  }

  const round = {
    id: uuidv4(),
    name,
    description: description || '',
    matchingPool: poolAmountWei.toString(),
    matchingPoolFormatted: formatETH(poolAmountWei),
    startTime: Date.now(),
    endTime: Date.now() + (durationDays || 14) * 24 * 60 * 60 * 1000,
    status: 'active',
    createdAt: Date.now()
  };

  rounds.set(round.id, round);
  console.log(`[ROUND] Created: ${round.name} with ${round.matchingPoolFormatted}`);
  res.status(201).json(round);
});

app.get('/rounds', (req, res) => {
  res.json(Array.from(rounds.values()).sort((a, b) => b.createdAt - a.createdAt));
});

app.get('/rounds/:id', (req, res) => {
  const round = rounds.get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  res.json({ ...round, matching: calculateQFMatching(round.id) });
});

app.post('/rounds/:id/end', requireWhitelist(), (req, res) => {
  const round = rounds.get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'active') return res.status(400).json({ error: 'Round not active' });

  round.status = 'pending_payout';
  round.endedAt = Date.now();
  rounds.set(round.id, round);
  console.log(`[ROUND] Ended: ${round.name}`);
  res.json({ success: true, round });
});

app.post('/rounds/:id/finalize', requireWhitelist(), async (req, res) => {
  const round = rounds.get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'pending_payout') {
    return res.status(400).json({ error: 'Round must be ended first' });
  }
  if (!getWallet()) {
    return res.status(500).json({ error: 'Wallet not configured' });
  }

  const matching = calculateQFMatching(round.id);
  const payoutResults = [];
  let totalFees = 0n;
  const FEE_PERCENT = 5n; // 5% fee to treasury

  for (const [projectId, funding] of Object.entries(matching?.projects || {})) {
    const project = projects.get(projectId);
    if (!project) continue;

    const grossPayout = BigInt(funding.totalFunding);
    if (grossPayout <= 0n) continue;

    // Calculate 5% fee (stays in treasury)
    const fee = (grossPayout * FEE_PERCENT) / 100n;
    const netPayout = grossPayout - fee;
    totalFees += fee;

    try {
      console.log(`[PAYOUT] ${formatETH(netPayout)} -> ${project.agentAddress} (fee: ${formatETH(fee)})`);
      const result = await sendETH(project.agentAddress, netPayout);

      const payout = {
        id: uuidv4(),
        roundId: round.id,
        projectId,
        projectName: project.name,
        recipient: project.agentAddress,
        grossAmount: grossPayout.toString(),
        fee: fee.toString(),
        feeFormatted: formatETH(fee),
        netAmount: netPayout.toString(),
        netAmountFormatted: formatETH(netPayout),
        txHash: result.txHash,
        status: 'submitted',
        createdAt: Date.now()
      };
      payouts.set(payout.id, payout);
      payoutResults.push(payout);
      console.log(`[PAYOUT] Success: ${result.txHash}`);
    } catch (err) {
      console.error(`[PAYOUT] Failed: ${err.message}`);
      payoutResults.push({ projectId, error: err.message, status: 'failed' });
    }
  }

  round.status = 'finalized';
  round.finalizedAt = Date.now();
  round.totalFeesCollected = totalFees.toString();
  rounds.set(round.id, round);

  res.json({ 
    success: true, 
    round, 
    payouts: payoutResults,
    feesCollected: formatETH(totalFees),
    feePercent: '5%'
  });
});

// ============================================================================
// API: PROJECTS
// ============================================================================

app.post('/projects', requireWhitelist(), (req, res) => {
  const { name, description, address, roundId } = req.body;

  if (!name || !address || !roundId) {
    return res.status(400).json({ error: 'name, address, and roundId required' });
  }

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const round = rounds.get(roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'active') return res.status(400).json({ error: 'Round not active' });

  const project = {
    id: uuidv4(),
    name,
    description: description || '',
    agentAddress: address.toLowerCase(),
    roundId,
    createdAt: Date.now()
  };

  projects.set(project.id, project);
  console.log(`[PROJECT] Registered: ${name}`);
  res.status(201).json(project);
});

app.get('/projects', (req, res) => {
  const { roundId } = req.query;
  let results = Array.from(projects.values());
  if (roundId) results = results.filter(p => p.roundId === roundId);

  results = results.map(p => {
    const matching = calculateQFMatching(p.roundId);
    return { ...p, funding: matching?.projects[p.id] || {} };
  });

  res.json(results);
});

app.get('/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const matching = calculateQFMatching(project.roundId);
  const contribs = Array.from(contributions.values())
    .filter(c => c.projectId === project.id && c.verified);

  res.json({ ...project, funding: matching?.projects[project.id] || {}, contributions: contribs });
});

// ============================================================================
// API: CONTRIBUTIONS
// ============================================================================

app.post('/contributions', requireWhitelist(), async (req, res) => {
  const { projectId, address, amount, txHash } = req.body;

  if (!projectId || !address || !amount || !txHash) {
    return res.status(400).json({ error: 'projectId, address, amount (ETH), and txHash required' });
  }

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const project = projects.get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const round = rounds.get(project.roundId);
  if (!round || round.status !== 'active') {
    return res.status(400).json({ error: 'Round not active' });
  }

  // Check duplicate
  const existing = Array.from(contributions.values()).find(c => c.txHash?.toLowerCase() === txHash.toLowerCase());
  if (existing) {
    return res.status(400).json({ error: 'Transaction already used' });
  }

  let amountWei;
  try {
    amountWei = parseETH(amount);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid amount format' });
  }

  console.log(`[VERIFY] tx ${txHash.slice(0, 10)}... for ${formatETH(amountWei)}`);
  const verification = await verifyETHTransfer(txHash, address, amountWei);

  if (!verification.valid) {
    return res.status(400).json({ error: 'Verification failed', details: verification.error });
  }

  const contribution = {
    id: uuidv4(),
    projectId,
    roundId: project.roundId,
    contributorAddress: verification.from,
    amount: verification.amount,
    amountFormatted: formatETH(verification.amount),
    txHash,
    blockNumber: verification.blockNumber,
    verified: true,
    createdAt: Date.now()
  };

  contributions.set(contribution.id, contribution);
  console.log(`[CONTRIBUTION] Verified: ${contribution.amountFormatted} for ${project.name}`);

  const matching = calculateQFMatching(project.roundId);
  res.status(201).json({ contribution, projectFunding: matching?.projects[projectId] });
});

// ============================================================================
// API: UTILITY
// ============================================================================

app.get('/treasury', async (req, res) => {
  const balance = await getTreasuryBalance();
  const committed = Array.from(rounds.values())
    .filter(r => r.status === 'active' || r.status === 'pending_payout')
    .reduce((sum, r) => sum + BigInt(r.matchingPool), 0n);

  res.json({
    address: TREASURY_ADDRESS,
    balance: formatETH(balance),
    committed: formatETH(committed),
    available: formatETH(balance - committed),
    network: 'Base',
    payoutsEnabled: !!TREASURY_PRIVATE_KEY
  });
});

app.get('/leaderboard/:roundId', (req, res) => {
  const round = rounds.get(req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const matching = calculateQFMatching(req.params.roundId);
  const leaderboard = Object.values(matching?.projects || {})
    .map(p => ({ ...p, projectName: projects.get(p.projectId)?.name }))
    .sort((a, b) => BigInt(b.totalFunding) > BigInt(a.totalFunding) ? 1 : -1);

  res.json({ round: round.name, status: round.status, matchingPool: round.matchingPoolFormatted, projects: leaderboard });
});

app.get('/stats', (req, res) => {
  const verified = Array.from(contributions.values()).filter(c => c.verified);
  const total = verified.reduce((sum, c) => sum + BigInt(c.amount), 0n);

  res.json({
    rounds: rounds.size,
    activeRounds: Array.from(rounds.values()).filter(r => r.status === 'active').length,
    projects: projects.size,
    contributions: verified.length,
    totalContributed: formatETH(total),
    payouts: payouts.size
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', network: 'Base', treasury: TREASURY_ADDRESS, payoutsEnabled: !!TREASURY_PRIVATE_KEY });
});

/**
 * Agent documentation endpoint
 * GET /agent
 */
app.get('/agent', (req, res) => {
  res.json({
    name: "Agent QF",
    description: "Quadratic Funding platform for AI agents. Contributors fund projects, matching pool amplifies small donations using QF math.",
    network: "Base (chainId 8453)",
    treasury_fee: "5%",
    endpoints: [
      {
        method: "POST",
        path: "/rounds",
        description: "Create a new QF funding round",
        body: { name: "string - required", description: "string", matchingPool: "string - ETH amount (e.g. '0.5')", durationDays: "number - default 14" },
        returns: { id: "string", name: "string", matchingPool: "string", status: "string" }
      },
      {
        method: "GET",
        path: "/rounds",
        description: "List all funding rounds",
        returns: { rounds: "array of round objects" }
      },
      {
        method: "GET",
        path: "/rounds/:id",
        description: "Get round details with current matching calculations",
        returns: { round: "object", matching: "object with project allocations" }
      },
      {
        method: "POST",
        path: "/projects",
        description: "Register a project for a funding round",
        body: { name: "string - required", description: "string", address: "string - payout address", roundId: "string - required" },
        returns: { id: "string", name: "string", roundId: "string" }
      },
      {
        method: "GET",
        path: "/projects",
        description: "List projects, optionally filtered by round",
        query: { roundId: "string" },
        returns: { projects: "array with funding info" }
      },
      {
        method: "POST",
        path: "/contributions",
        description: "Contribute to a project (send ETH to treasury first)",
        body: { projectId: "string - required", address: "string - required", amount: "string - ETH amount", txHash: "string - required" },
        returns: { contribution: "object", projectFunding: "object with match calculations" }
      },
      {
        method: "POST",
        path: "/rounds/:id/end",
        description: "End a funding round (stops contributions)",
        returns: { round: "object with status pending_payout" }
      },
      {
        method: "POST",
        path: "/rounds/:id/finalize",
        description: "Distribute matching pool to projects",
        returns: { payouts: "array of payout txs", feesCollected: "string" }
      },
      {
        method: "GET",
        path: "/leaderboard/:roundId",
        description: "Get project rankings by total funding",
        returns: { projects: "array sorted by totalFunding" }
      },
      {
        method: "GET",
        path: "/treasury",
        description: "Treasury balance and status",
        returns: { balance: "string", committed: "string", available: "string" }
      }
    ],
    example_flow: [
      "1. POST /rounds - Create funding round with matching pool",
      "2. POST /projects - Register project in round",
      "3. Send ETH to treasury address",
      "4. POST /contributions - Record contribution with txHash",
      "5. POST /rounds/:id/end - End round",
      "6. POST /rounds/:id/finalize - Distribute funds (5% fee)"
    ],
    x402_enabled: false
  });
});

// ============================================================================
// E2E TEST ENDPOINT (single request to avoid serverless state loss)
// ============================================================================

app.post('/test/e2e', async (req, res) => {
  const { contributionTxHash, recipientAddress } = req.body;
  
  if (!contributionTxHash) {
    return res.status(400).json({ 
      error: 'contributionTxHash required',
      example: 'POST /test/e2e with {"contributionTxHash":"0x...", "recipientAddress":"0x..."}'
    });
  }

  const recipient = recipientAddress || TREASURY_ADDRESS;
  const results = { steps: [] };

  try {
    // Step 1: Create round
    const matchingPool = ethers.parseEther('0.005');
    const round = {
      id: uuidv4(),
      name: 'E2E Test Round',
      matchingPool: matchingPool.toString(),
      matchingPoolFormatted: formatETH(matchingPool),
      status: 'active',
      createdAt: Date.now()
    };
    rounds.set(round.id, round);
    results.steps.push({ step: 'create_round', roundId: round.id, matchingPool: round.matchingPoolFormatted });

    // Step 2: Create project
    const project = {
      id: uuidv4(),
      name: 'E2E Test Project',
      agentAddress: recipient.toLowerCase(),
      roundId: round.id,
      createdAt: Date.now()
    };
    projects.set(project.id, project);
    results.steps.push({ step: 'create_project', projectId: project.id, recipient: project.agentAddress });

    // Step 3: Verify and record contribution
    const verification = await verifyETHTransfer(contributionTxHash, null, 0n);
    if (!verification.valid) {
      return res.status(400).json({ error: 'Contribution tx verification failed', details: verification.error });
    }

    const contribution = {
      id: uuidv4(),
      projectId: project.id,
      roundId: round.id,
      contributorAddress: verification.from,
      amount: verification.amount,
      amountFormatted: formatETH(verification.amount),
      txHash: contributionTxHash,
      verified: true,
      createdAt: Date.now()
    };
    contributions.set(contribution.id, contribution);
    results.steps.push({ step: 'contribution_verified', amount: contribution.amountFormatted, from: contribution.contributorAddress });

    // Step 4: End round
    round.status = 'pending_payout';
    rounds.set(round.id, round);
    results.steps.push({ step: 'round_ended' });

    // Step 5: Calculate and send payout
    const matching = calculateQFMatching(round.id);
    const projectFunding = matching?.projects[project.id];
    
    if (!projectFunding) {
      return res.status(400).json({ error: 'No funding calculated' });
    }

    const grossPayout = BigInt(projectFunding.totalFunding);
    const fee = (grossPayout * 5n) / 100n; // 5% fee
    const netPayout = grossPayout - fee;
    
    results.steps.push({ 
      step: 'payout_calculated', 
      direct: projectFunding.directFundingFormatted, 
      match: projectFunding.matchAmountFormatted, 
      gross: projectFunding.totalFundingFormatted,
      fee: formatETH(fee) + ' (5%)',
      net: formatETH(netPayout)
    });

    // Send payout (minus 5% fee which stays in treasury)
    if (netPayout > 0n && getWallet()) {
      const payoutResult = await sendETH(recipient, netPayout);
      results.steps.push({ step: 'payout_sent', txHash: payoutResult.txHash, amount: formatETH(netPayout), fee: formatETH(fee), status: payoutResult.status });
      results.payoutTxHash = payoutResult.txHash;
    } else {
      results.steps.push({ step: 'payout_skipped', reason: netPayout <= 0n ? 'zero amount' : 'no wallet' });
    }

    // Mark round finalized
    round.status = 'finalized';
    rounds.set(round.id, round);

    results.success = true;
    results.summary = {
      roundId: round.id,
      projectId: project.id,
      contributionTxHash,
      payoutTxHash: results.payoutTxHash || null,
      recipient,
      grossAmount: formatETH(grossPayout),
      fee: formatETH(fee) + ' (5%)',
      netPaid: formatETH(netPayout)
    };

    res.json(results);

  } catch (err) {
    results.error = err.message;
    res.status(500).json(results);
  }
});

// ============================================================================
// FRONTEND
// ============================================================================

app.get('/', async (req, res) => {
  const balance = await getTreasuryBalance();
  const activeRounds = Array.from(rounds.values()).filter(r => r.status === 'active');

  res.send(`
<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent QF</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui;background:#0d1117;color:#e6edf3;min-height:100vh;padding:2rem}
    .container{max-width:800px;margin:0 auto}
    h1{font-size:2rem;margin-bottom:1rem;color:#58a6ff}
    .badge{background:#238636;color:white;padding:0.25rem 0.5rem;border-radius:4px;font-size:0.75rem}
    .stats{display:flex;gap:2rem;margin:2rem 0;flex-wrap:wrap}
    .stat{text-align:center}
    .stat-value{font-size:1.5rem;font-weight:bold;color:#58a6ff}
    .stat-label{color:#8b949e;font-size:0.8rem}
    .section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin:1rem 0}
    .endpoint{font-family:monospace;padding:0.5rem 0;border-bottom:1px solid #30363d;font-size:0.85rem}
    .method{color:#3fb950;width:50px;display:inline-block}
    a{color:#58a6ff}
  </style>
</head><body>
  <div class="container">
    <h1>🔲 Agent QF <span class="badge">LIVE ON BASE</span></h1>
    <p style="color:#8b949e">Quadratic Funding for AI Agents — Real ETH payments</p>
    
    <div class="stats">
      <div class="stat"><div class="stat-value">${formatETH(balance)}</div><div class="stat-label">Treasury</div></div>
      <div class="stat"><div class="stat-value">${activeRounds.length}</div><div class="stat-label">Active Rounds</div></div>
      <div class="stat"><div class="stat-value">${contributions.size}</div><div class="stat-label">Contributions</div></div>
    </div>

    <div class="section">
      <h3 style="margin-bottom:0.5rem">API</h3>
      <div class="endpoint"><span class="method">POST</span>/rounds — Create round</div>
      <div class="endpoint"><span class="method">POST</span>/projects — Register project</div>
      <div class="endpoint"><span class="method">POST</span>/contributions — Contribute (with txHash)</div>
      <div class="endpoint"><span class="method">POST</span>/rounds/:id/end — End round</div>
      <div class="endpoint"><span class="method">POST</span>/rounds/:id/finalize — Distribute funds</div>
      <div class="endpoint"><span class="method">GET</span>/treasury — Balance info</div>
    </div>

    <p style="margin-top:2rem;color:#8b949e;font-size:0.85rem">
      Treasury: <a href="https://basescan.org/address/${TREASURY_ADDRESS}">${TREASURY_ADDRESS}</a>
    </p>
  </div>
</body></html>
  `);
});

// ============================================================================
// START
// ============================================================================

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`Agent QF running on :${PORT}`));
module.exports = app;
