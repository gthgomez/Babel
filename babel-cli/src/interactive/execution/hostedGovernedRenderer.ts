import { AppendOnlyRenderer } from '../../ui/waterfall.js'
import { sanitizeUntrustedTerminalBlock } from '../../ui/sanitize.js'
import type { EventBus, RendererContext } from '../../ui/rendererSupport.js'
import type { ShellRuntimeBinding } from '../../ui/shell/shellRuntimeBinding.js'

/** Present governed progress through the current shell without owning stdout. */
export class HostedGovernedRenderer extends AppendOnlyRenderer {
  private readonly ownerBus: EventBus
  private readonly events: string[]
  private readonly ownsTurn: () => boolean
  private readonly sourceEpoch: number
  private readonly shell: ShellRuntimeBinding
  private readonly onChunk: (payload: unknown) => void
  private readonly onThought: (text: unknown) => void

  constructor(bus: EventBus, context: RendererContext, shell: ShellRuntimeBinding, stillBound: () => boolean) {
    const epoch = shell.store.epoch
    const turnId = shell.store.turnId
    const ownsTurn = () => stillBound() && shell.store.epoch === epoch && shell.store.turnId === turnId
    const events: string[] = []
    super(bus, context, line => {
      if (!ownsTurn()) return
      events.push(line)
      shell.appendNotice(line, { preserveFull: true })
    })
    this.ownerBus = bus
    this.events = events
    this.ownsTurn = ownsTurn
    this.sourceEpoch = epoch
    this.shell = shell
    this.onChunk = payload => {
      if (!this.ownsTurn() || !payload || typeof payload !== 'object' || !('chunk' in payload)) return
      const chunk = payload.chunk
      if (typeof chunk !== 'string' || !chunk) return
      this.events.push(chunk)
      this.shell.onChatEvent({ type: 'answer_chunk', text: chunk }, this.sourceEpoch)
    }
    this.onThought = text => {
      if (!this.ownsTurn() || typeof text !== 'string' || !text) return
      this.events.push(text)
      this.shell.onChatEvent({ type: 'thought', text }, this.sourceEpoch)
    }
    bus.on('assistant_chunk', this.onChunk)
    bus.on('assistant_thought', this.onThought)
  }

  override start(): void {
    if (this.ownsTurn()) this.shell.onChatEvent({ type: 'thinking' }, this.sourceEpoch)
    super.start()
  }

  override stop(): void {
    this.ownerBus.off('assistant_chunk', this.onChunk)
    this.ownerBus.off('assistant_thought', this.onThought)
    super.stop()
  }

  override getTranscript(): string {
    return sanitizeUntrustedTerminalBlock(this.events.join(''))
  }
}
