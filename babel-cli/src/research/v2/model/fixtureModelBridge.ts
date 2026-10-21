import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
} from '../ports/researchModelPort.js'
import { FakeResearchModelPort } from '../fixtures/fakePorts.js'

/**
 * M1 model bridge slice — delegates to fixture port (no live ProviderEngine / OpenRouter).
 */
export class FixtureResearchModelBridge implements ResearchModelPort {
  readonly fixture = new FakeResearchModelPort()

  scriptOutput(operationId: string, output: unknown): void {
    this.fixture.scriptOutput(operationId, output)
  }

  invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
    if (!request.attemptId) {
      return Promise.reject(new Error('ResearchModelInvocationRequest.attemptId is required'))
    }
    return this.fixture.invokeStructured(request)
  }
}
