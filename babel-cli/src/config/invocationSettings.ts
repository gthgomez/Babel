/** Non-secret invocation preferences follow asynchronous CLI work without changing process environment. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { UserPreferences } from './userSettings.js'
const invocation = new AsyncLocalStorage<UserPreferences>()
export function withInvocationSettings<T>(settings: UserPreferences, run: () => T): T { return invocation.run(settings, run) }
export function currentInvocationSettings(): UserPreferences | undefined { return invocation.getStore() }
