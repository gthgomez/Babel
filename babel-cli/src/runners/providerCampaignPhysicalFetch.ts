import type { PreparedProviderRequest } from './preparedProviderRequest.js'
import { prepareProviderRequest } from './preparedProviderRequest.js'
import type { ProviderInvocationCompleted, RunnerCallbacks } from './base.js'
import { dispatchRunOperation } from '../runtime/run-control.js'
import { RunStoppedError } from '../runtime/run-control.js'
import type { RunControl } from '../runtime/run-control.js'

/** Immutable per-invocation campaign state; never stored on the runner instance. */
export class CampaignPhysicalFetchSession {
  private openAdmission: PreparedProviderRequest | null = null
  /** True only after dispatchRunOperation invoked the physical fetch callback. */
  private physicalFetchCallbackEntered = false

  constructor(private readonly callbacks: RunnerCallbacks | undefined) {}

  private get meter() {
    return this.callbacks?.campaignMeter ?? null
  }

  rebindPhysicalAttempt(base: PreparedProviderRequest, attemptId: string): PreparedProviderRequest {
    if (attemptId === base.attempt_id) return base
    return prepareProviderRequest({
      body: base.body,
      mode: base.mode,
      provider: base.provider,
      requestedModelId: base.requested_model_id,
      normalizedModelId: base.normalized_model_id,
      sentModelId: base.sent_model_id,
      requestId: base.request_id,
      attemptId,
      parentRequestId: base.parent_request_id,
      reservedCompletionTokens: base.accounting.reserved_completion_tokens,
      ...(base.context_limit_tokens === null
        ? {}
        : {
            contextLimitTokens: base.context_limit_tokens,
            contextLimitSource: base.context_limit_source,
          }),
    })
  }

  async admitBeforeWire(
    basePrepared: PreparedProviderRequest,
    physicalAttemptId: string,
    runControl?: RunControl,
  ): Promise<PreparedProviderRequest> {
    const meter = this.meter
    if (!meter) return this.rebindPhysicalAttempt(basePrepared, physicalAttemptId)
    const physical = this.rebindPhysicalAttempt(basePrepared, physicalAttemptId)
    await meter.gate.admitBeforeDispatch({
      executionStage: meter.executionStage,
      preparedRequest: physical,
      ...(runControl ? { runControl } : {}),
    })
    this.openAdmission = physical
    return physical
  }

  async dispatchAdmittedFetch(input: {
    basePrepared: PreparedProviderRequest
    physicalAttemptId: string
    operationId: string
    runControl?: RunControl
    fetch: () => Promise<Response>
  }): Promise<Response> {
    const meter = this.meter
    this.physicalFetchCallbackEntered = false
    await this.admitBeforeWire(input.basePrepared, input.physicalAttemptId, input.runControl)
    if (!meter) {
      return input.fetch()
    }
    try {
      meter.gate.repeatRunControlBeforeFetch(input.runControl)
      return await dispatchRunOperation(input.runControl, 'model', input.operationId, () => {
        this.physicalFetchCallbackEntered = true
        return input.fetch()
      })
    } catch (error) {
      if (error instanceof RunStoppedError) {
        this.settleOpenAdmissionAfterRunStopped(this.physicalFetchCallbackEntered)
      }
      throw error
    }
  }

  /**
   * Physical-session owner settlement after handoff: zero when the fetch callback
   * never ran; unknown only when transmission may have started.
   */
  settleOpenAdmissionAfterRunStopped(physicalFetchCallbackEntered: boolean): void {
    if (physicalFetchCallbackEntered) {
      this.settleUnknownOnOpenAdmission()
      return
    }
    this.settleZeroOnOpenAdmission()
  }

  settleZeroOnOpenAdmission(): void {
    const meter = this.meter
    const prepared = this.openAdmission
    if (!meter || !prepared) return
    meter.gate.settleZeroForProvableNoWire({
      executionStage: meter.executionStage,
      requestId: prepared.request_id,
      attemptId: prepared.attempt_id,
    })
    this.openAdmission = null
    this.physicalFetchCallbackEntered = false
  }

  settleUnknownOnOpenAdmission(): void {
    const meter = this.meter
    const prepared = this.openAdmission
    if (!meter || !prepared) return
    meter.gate.settleUnknownOnTransportFailure({
      executionStage: meter.executionStage,
      requestId: prepared.request_id,
      attemptId: prepared.attempt_id,
    })
    this.openAdmission = null
    this.physicalFetchCallbackEntered = false
  }

  settleFromCompleted(completed: ProviderInvocationCompleted): void {
    const meter = this.meter
    const prepared = this.openAdmission
    if (!meter || !prepared) return
    meter.gate.settleFromCompleted({
      executionStage: meter.executionStage,
      requestId: prepared.request_id,
      attemptId: prepared.attempt_id,
      completed,
    })
    this.openAdmission = null
    this.physicalFetchCallbackEntered = false
  }

  finalizeInvocation(status: 'delivered' | 'failed', completed: ProviderInvocationCompleted): void {
    if (!this.meter) return
    if (status === 'delivered') {
      this.settleFromCompleted(completed)
      return
    }
    this.settleUnknownOnOpenAdmission()
  }
}
