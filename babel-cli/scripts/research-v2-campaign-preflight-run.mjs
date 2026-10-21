#!/usr/bin/env node
/**
 * Portable campaign preflight entry (Windows-safe): sets BABEL_RESEARCH_V2_CAMPAIGN then runs preflight.
 * Usage: node scripts/research-v2-campaign-preflight-run.mjs [G-L1|G-L2|G-L3]
 */
const campaign = (process.argv[2] ?? 'G-L1').trim().toUpperCase()
process.env.BABEL_RESEARCH_V2_CAMPAIGN = campaign
await import('./research-v2-campaign-preflight.mjs')
