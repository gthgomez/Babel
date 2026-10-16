/** Pure window-lifecycle decisions. Electron stays in main.mjs. */

/** Grace after cancel so the 1.5s process-tree kill can finish. */
export const CLOSE_GRACE_MS = 3500;

/**
 * @param {{ busy?: boolean, closing?: boolean }} state
 * @returns {'close' | 'ask' | 'wait'}
 */
export function decideWindowClose(state) {
  if (state?.closing) return 'wait';
  if (state?.busy) return 'ask';
  return 'close';
}

/** Serialize the user's close decision; failure to create background controls must not hide work. */
export function createCloseRequest({ask,background,stopAndClose,onError}) {
  let prompting=false,closing=false;
  return async()=>{
    if(prompting||closing)return;
    prompting=true;
    try{
      const choice=await ask();
      if(choice==='background')await background();
      else if(choice==='stop'){closing=true;if(await stopAndClose()===false)closing=false;}
    }catch(error){closing=false;onError(error);}
    finally{prompting=false;}
  };
}

/** The last window always ends the process, including during a run. */
export function decideLastWindow() {
  return 'quit';
}
