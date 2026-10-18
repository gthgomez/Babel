import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDesktopApprovalBinding, matchesDesktopApprovalReply } from './desktopApprovalBinding.js';

const now=Date.parse('2026-10-15T00:00:00Z');
const request={request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64)};
test('Desktop replies bind every approval field and expire without consuming another request',()=>{
  const binding=makeDesktopApprovalBinding(request,'run-1',now);
  assert.ok(binding);
  const reply={decision:'allow_once',approval:binding};
  assert.equal(matchesDesktopApprovalReply(reply,binding,now),true);
  assert.equal(matchesDesktopApprovalReply({decision:'allow_once'},binding,now),false);
  for(const field of ['request_id','thread_id','turn_id','operation_digest','run_id','expires_at'] as const){
    assert.equal(matchesDesktopApprovalReply({...reply,approval:{...binding,[field]:'other'}},binding,now),false,field);
  }
  assert.equal(matchesDesktopApprovalReply(reply,binding,Date.parse(binding.expires_at)),false);
  assert.equal(matchesDesktopApprovalReply({...reply,decision:'allow_session'},binding,now),false);
  const {operation_digest:_,...unbound}=request;
  assert.equal(makeDesktopApprovalBinding(unbound,'run-1',now),null);
  assert.equal(makeDesktopApprovalBinding(request,undefined,now),null);
});
