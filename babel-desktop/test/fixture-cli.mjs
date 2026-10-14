// Local transport test fixture, not a Babel runtime or a fake production engine.
process.stdout.write(JSON.stringify({type:'run_start'})+'\n');
process.stdout.write(JSON.stringify({type:'fixture_environment',daemonEnabled:process.env.BABEL_DAEMON_ENABLED})+'\n');
process.stdout.write(JSON.stringify({type:'fixture_route',compactionModel:process.env.BABEL_COMPACTION_MODEL,criticModel:process.env.BABEL_DIFF_CRITIC_MODEL})+'\n');
setTimeout(()=>process.stdout.write(JSON.stringify({type:'assistant_chunk',chunk:'Fixture transport works.'})+'\n'),40);
setTimeout(()=>{process.stdout.write(JSON.stringify({type:'run_complete',result:{terminal_outcome:'VERIFIED_COMPLETE',summary:'Fixture only.'}})+'\n');},100);
