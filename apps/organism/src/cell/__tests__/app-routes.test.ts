import { describe, expect, it, vi } from 'vitest'
import '@shrubbery/components'
import type {
  MnAuthPage,
  MnAuthResendVerificationDetail,
  MnAuthSignInDetail,
  MnAuthSignUpDetail,
  MnAuthVerifyEmailDetail,
  MnGardenHome,
  MnLifetimeBanner,
  MnLifetimeBannerDetail,
  MnLifetimeBannerState,
  MnOpsHealthPage,
  MnSettingsPage,
} from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import {
  detectOrganismAppRoute,
  mountOrganismAppRoute,
  type OrganismAppRoute,
} from '../app-routes.js'

describe('Organism app route mounts', () => {
  it('detects Garden top-level shell routes', () => {
    expect(detectOrganismAppRoute(new URL('https://example.test/home'))).toEqual({ kind: 'home' })
    // /garden, /sophia-labs, /privacy and /terms are no longer routes: they
    // served Sophia Labs' marketing and policy pages. They must now fall
    // through like any other unknown path rather than resolving to a shell.
    for (const path of ['/garden', '/sophia-labs', '/labs', '/privacy.html', '/terms']) {
      expect(detectOrganismAppRoute(new URL(`https://example.test${path}`)), path).toBeNull()
    }
    expect(detectOrganismAppRoute(new URL('https://example.test/signup?email=nora@example.test'))).toEqual({
      kind: 'auth',
      mode: 'signup',
      pendingIdentity: 'nora@example.test',
      deliveryDestination: 'nora@example.test',
      deliveryMedium: '',
      successMessage: '',
    })
    expect(detectOrganismAppRoute(new URL('https://example.test/settings#billing'))).toEqual({
      kind: 'settings',
      sectionId: 'billing',
    })
    expect(detectOrganismAppRoute(new URL('https://example.test/?view=ops-health'))).toEqual({
      kind: 'ops-health',
    })
    // Choreograph and the standalone chat were removed; their old links land on Home.
    for (const path of ['/choreograph/run/run-7?g=graph-a', '/?chat-standalone=1', '/chat', '/chat-debug.html']) {
      expect(detectOrganismAppRoute(new URL(`https://example.test${path}`)), path).toEqual({ kind: 'home' })
    }
    expect(detectOrganismAppRoute(new URL('https://example.test/public/wiki'))).toBeNull()
  })

  it('mounts /home as the account-level Garden route over a shell-owned catalog service', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const opened: string[] = []
    const workspace = {
      graphId: 'koch-morse',
      title: 'Morse Garden',
      role: 'owner' as const,
      cellState: 'running' as const,
      lastOpenedAt: Date.now(),
    }
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/home'),
      gardenHomeService: {
        async load() {
          return {
            account: { userId: 'nora', displayName: 'Nora' },
            workspaces: [workspace],
          }
        },
        openGraph(graph) {
          opened.push(graph.graphId)
        },
      },
    })

    expect(mount?.route).toEqual({ kind: 'home' })
    await mount!.ready
    const page = host.querySelector('mn-garden-home') as MnGardenHome
    await page.updateComplete

    expect(host.querySelector('[data-organism-route="home"]')).not.toBeNull()
    expect(host.querySelector('mn-top-bar')).toBeNull()
    expect(page.status).toBe('ready')
    expect(page.account?.displayName).toBe('Nora')
    expect(page.workspaces).toEqual([workspace])

    page.dispatchEvent(new CustomEvent('mn-garden-home-open-graph', {
      detail: { workspace },
      bubbles: true,
      composed: true,
    }))
    await Promise.resolve()
    expect(opened).toEqual(['koch-morse'])

    mount!.destroy()
    host.remove()
  })

  it('mounts auth route as controlled chrome and leaves auth effects to the shell', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const signIns: Array<{ detail: MnAuthSignInDetail; mode: string }> = []

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/login?mode=verify&identity=nora@example.test&success=Email%20verified'),
      onAuthSignIn: (detail, route) => {
        signIns.push({ detail, mode: route.mode })
      },
    })

    expect(mount?.route).toEqual({
      kind: 'auth',
      mode: 'verify',
      pendingIdentity: 'nora@example.test',
      deliveryDestination: 'nora@example.test',
      deliveryMedium: '',
      successMessage: 'Email verified',
    })
    await mount!.ready
    const page = host.querySelector('mn-auth-page') as MnAuthPage
    await page.updateComplete

    expect(page.mode).toBe('verify')
    expect(page.pendingIdentity).toBe('nora@example.test')
    expect(page.successMessage).toBe('Email verified')
    expect(host.querySelector('[data-organism-route="auth"]')).not.toBeNull()
    expect(host.querySelector('mn-top-bar')).toBeNull()

    page.dispatchEvent(new CustomEvent<MnAuthSignInDetail>('mn-auth-sign-in-submit', {
      detail: { identity: 'nora@example.test', password: 'correct horse' },
      bubbles: true,
      composed: true,
    }))
    expect(signIns).toEqual([
      {
        detail: { identity: 'nora@example.test', password: 'correct horse' },
        mode: 'verify',
      },
    ])

    mount!.destroy()
    host.remove()
  })

  it('drives real auth actions through controlled loading, verification, and success states', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const calls: string[] = []
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/signup'),
      authActions: {
        async signIn(detail) {
          calls.push(`signin:${detail.identity}`)
        },
        async signUp(detail) {
          calls.push(`signup:${detail.username}`)
          return {
            identity: detail.username,
            confirmed: false,
            deliveryDestination: 'v***@example.test',
            deliveryMedium: 'EMAIL',
          }
        },
        async verifyEmail(detail) {
          calls.push(`verify:${detail.identity}:${detail.code}`)
        },
        async resendVerification(detail) {
          calls.push(`resend:${detail.identity}`)
          return { deliveryDestination: 'new@example.test', deliveryMedium: 'EMAIL' }
        },
      },
      onAuthSuccess: (kind) => {
        calls.push(`success:${kind}`)
      },
    })
    await mount!.ready
    const page = host.querySelector('mn-auth-page') as MnAuthPage

    page.dispatchEvent(new CustomEvent<MnAuthSignUpDetail>('mn-auth-sign-up-submit', {
      detail: {
        username: 'nora',
        email: 'nora@example.test',
        name: 'Nora',
        password: 'Secret123',
        acceptedPrivacy: true,
        acceptedTerms: true,
      },
      bubbles: true,
      composed: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.signUpStatus).toBe('success')
    expect(page.mode).toBe('verify')
    expect(page.pendingIdentity).toBe('nora')
    expect(page.deliveryDestination).toBe('v***@example.test')

    page.dispatchEvent(new CustomEvent<MnAuthResendVerificationDetail>('mn-auth-resend-verification', {
      detail: { identity: 'nora' },
      bubbles: true,
      composed: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.verifyStatus).toBe('success')
    expect(page.deliveryDestination).toBe('new@example.test')

    page.dispatchEvent(new CustomEvent<MnAuthVerifyEmailDetail>('mn-auth-verify-email-submit', {
      detail: { identity: 'nora', code: '123456' },
      bubbles: true,
      composed: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.mode).toBe('signin')
    expect(page.successMessage).toContain('Email verified')
    expect(calls).toEqual([
      'signup:nora',
      'resend:nora',
      'verify:nora:123456',
      'success:verify',
    ])

    mount!.destroy()
    host.remove()
  })

  it('projects auth failures into the controlled page without an unhandled rejection', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/login'),
      authActions: {
        async signIn() {
          const error = new Error('Verify your email before signing in.') as Error & {
            isUserNotConfirmed: boolean
          }
          error.isUserNotConfirmed = true
          throw error
        },
        async signUp() {
          return { confirmed: false }
        },
        async verifyEmail() {},
        async resendVerification() {
          return {}
        },
      },
    })
    await mount!.ready
    const page = host.querySelector('mn-auth-page') as MnAuthPage
    page.dispatchEvent(new CustomEvent<MnAuthSignInDetail>('mn-auth-sign-in-submit', {
      detail: { identity: 'nora@example.test', password: 'wrong' },
      bubbles: true,
      composed: true,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.signInStatus).toBe('error')
    expect(page.signInError).toContain('Verify your email')
    expect(page.mode).toBe('verify')
    expect(page.pendingIdentity).toBe('nora@example.test')

    mount!.destroy()
    host.remove()
  })

  it('mounts settings route with the requested section', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#api-keys'),
    })

    expect(mount?.route).toEqual({ kind: 'settings', sectionId: 'api-keys' })
    await mount!.ready
    const settings = host.querySelector('mn-settings-page') as MnSettingsPage
    await settings.updateComplete

    expect(settings.activeSection).toBe('api-keys')
    // Settings has its own header; the app's top bar stays out of it.
    expect(host.querySelector('mn-top-bar')).toBeNull()
    expect(host.querySelector('[data-organism-route="settings"]')).not.toBeNull()

    mount!.destroy()
    host.remove()
  })

  it('mounts <mn-lifetime-banner> WIRED, not bare — the assertion mn-upgrade-banner/mn-storage-banner would fail (master §3 Slice 7)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const bannerState: MnLifetimeBannerState = {
      reason: 'graph-recreated',
      graphTitle: 'Field Notes',
      previousLife: 'a1b2c3d4',
      parkedDocuments: 1,
      parkedOperations: 2,
      testimony: "stale graph incarnation: expected a1b2c3d4, actual e5f6a7b8",
    }
    const adopted: string[] = []
    const viewedParked: string[] = []

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#account'),
      lifetime: {
        state: bannerState,
        onAdopt: () => { adopted.push('adopted') },
        onViewParked: () => { viewedParked.push('viewed') },
      },
    })

    expect(mount?.route).toEqual({ kind: 'settings', sectionId: 'account' })
    await mount!.ready

    // A state prop REACHES it (not a bare mount with no props at all).
    const banner = host.querySelector('mn-lifetime-banner') as MnLifetimeBanner
    expect(banner).not.toBeNull()
    expect(banner.state).toEqual(bannerState)

    // Its events REACH the option handlers.
    banner.dispatchEvent(new CustomEvent<MnLifetimeBannerDetail>('mn-lifetime-primary', {
      detail: { reason: 'graph-recreated' },
      bubbles: true,
      composed: true,
    }))
    banner.dispatchEvent(new CustomEvent<MnLifetimeBannerDetail>('mn-lifetime-secondary', {
      detail: { reason: 'graph-recreated' },
      bubbles: true,
      composed: true,
    }))
    expect(adopted).toEqual(['adopted'])
    expect(viewedParked).toEqual(['viewed'])

    mount!.destroy()
    host.remove()
  })

  it('mounts <mn-restore-overlay> WIRED, not bare (master §3 Slice 9): real props reach it, and BOTH host events converge on one primary action', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const primary: string[] = []
    const secondary: string[] = []

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#account'),
      reapply: {
        view: {
          active: true,
          stage: 'restoring',
          progress: 42,
          heading: 'Reapplying parked work',
          message: 'Change 2 of 5 — document update',
          error: '',
        },
        primaryLabel: 'Open Field Notes',
        secondaryLabel: 'Back to parked work',
        onPrimary: () => { primary.push('primary') },
        onSecondary: () => { secondary.push('secondary') },
      },
    })
    await mount!.ready

    const overlay = host.querySelector('mn-restore-overlay') as HTMLElement & {
      active: boolean
      operationState: string
      progress: number
      heading: string
      message: string
      primaryLabel: string
      secondaryLabel: string
    }
    expect(overlay).not.toBeNull()
    expect(overlay.active).toBe(true)
    expect(overlay.operationState).toBe('restoring')
    expect(overlay.progress).toBe(42)
    expect(overlay.heading).toBe('Reapplying parked work')
    expect(overlay.message).toBe('Change 2 of 5 — document update')

    // Both terminal events converge on the SAME host action.
    overlay.dispatchEvent(new CustomEvent('mn-restore-overlay-reload', { bubbles: true, composed: true }))
    overlay.dispatchEvent(new CustomEvent('mn-restore-overlay-dismiss', { bubbles: true, composed: true }))
    overlay.dispatchEvent(new CustomEvent('mn-restore-overlay-secondary', { bubbles: true, composed: true }))
    expect(primary).toEqual(['primary', 'primary'])
    expect(secondary).toEqual(['secondary'])

    mount!.destroy()
    host.remove()
  })

  it('paints the Settings frame synchronously while its data is still loading', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let resolveLoad!: (snapshot: {
      userName: string
      userEmail: string
      sections: readonly []
    }) => void
    const load = new Promise<{
      userName: string
      userEmail: string
      sections: readonly []
    }>((resolve) => { resolveLoad = resolve })

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#account'),
      settingsService: {
        load: () => load,
        async toggle() {},
        async select() {},
        async secret() {},
        async action() {},
        async job() {},
      },
    })

    const settings = host.querySelector('mn-settings-page') as MnSettingsPage
    expect(settings).not.toBeNull()
    expect(settings.status).toBe('loading')
    expect(host.querySelector('[data-organism-route="settings"]')).not.toBeNull()
    expect(host.querySelector('.boot-placeholder')).toBeNull()

    resolveLoad({ userName: 'Nora', userEmail: '', sections: [] })
    await mount!.ready
    expect(settings.status).toBe('ready')
    mount!.destroy()
    host.remove()
  })

  it('drives settings interactions through the shell service and rerenders controlled rows', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let reducedMotion = false
    let loads = 0
    const toggles: unknown[] = []
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#appearance'),
      settingsService: {
        async load() {
          loads += 1
          return {
            userName: 'Nora',
            userEmail: 'nora@example.test',
            sections: [{
              id: 'appearance',
              title: 'Appearance',
              toggles: [{ id: 'reducedMotion', label: 'Reduce motion', checked: reducedMotion }],
            }],
          }
        },
        async toggle(detail) { toggles.push(detail); reducedMotion = detail.checked },
        async select() {},
        async secret() {},
        async action() {},
        async job() {},
      },
    })
    await mount!.ready
    let page = host.querySelector('mn-settings-page') as MnSettingsPage
    await page.updateComplete
    expect(page.status).toBe('ready')
    expect(page.userEmail).toBe('nora@example.test')
    const toggle = page.shadowRoot!.querySelector<HTMLButtonElement>('.toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    page = host.querySelector('mn-settings-page') as MnSettingsPage
    await page.updateComplete
    expect(toggles).toEqual([{ sectionId: 'appearance', settingId: 'reducedMotion', checked: true }])
    expect(page.shadowRoot!.querySelector('.toggle')?.getAttribute('aria-pressed')).toBe('true')
    expect(loads).toBe(2)

    mount!.destroy()
    host.remove()
  })

  it('streams shell-owned settings job progress without replacing the ready page', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let status = 'queued'
    let notify = (): void => undefined
    const unsubscribe = vi.fn()
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/settings#imports'),
      settingsService: {
        async load() {
          return {
            userName: 'Nora',
            userEmail: '',
            sections: [{
              id: 'imports',
              title: 'Imports',
              jobs: [{
                id: 'import-obsidian',
                label: 'Import Obsidian vault',
                status,
                detail: status === 'running' ? 'Parsing notes.zip' : status,
                progress: status === 'running' ? 42 : status === 'succeeded' ? 100 : 0,
                disabled: true,
              }],
            }],
          }
        },
        async toggle() {},
        async select() {},
        async secret() {},
        async action() {},
        async job() {},
        subscribe(callback) {
          notify = callback
          return unsubscribe
        },
      },
    })
    await mount!.ready
    let page = host.querySelector('mn-settings-page') as MnSettingsPage
    await page.updateComplete
    expect(page.status).toBe('ready')
    expect(page.sections[0]?.jobs?.[0]?.status).toBe('queued')

    status = 'running'
    notify()
    await new Promise(resolve => setTimeout(resolve, 0))
    page = host.querySelector('mn-settings-page') as MnSettingsPage
    await page.updateComplete
    expect(page.status).toBe('ready')
    expect(page.sections[0]?.jobs?.[0]).toMatchObject({
      status: 'running',
      progress: 42,
      detail: 'Parsing notes.zip',
    })

    status = 'succeeded'
    notify()
    await new Promise(resolve => setTimeout(resolve, 0))
    page = host.querySelector('mn-settings-page') as MnSettingsPage
    await page.updateComplete
    expect(page.sections[0]?.jobs?.[0]).toMatchObject({ status: 'succeeded', progress: 100 })

    mount!.destroy()
    expect(unsubscribe).toHaveBeenCalledOnce()
    host.remove()
  })

  it('mounts ops-health route and owns copy/back side effects', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const closed: OrganismAppRoute[] = []
    const copied: string[] = []

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/ops-health'),
      onClose: (route) => closed.push(route),
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value)
        },
      },
    })

    await mount!.ready
    const page = host.querySelector('mn-ops-health-page') as MnOpsHealthPage
    await page.updateComplete

    expect(mount?.route).toEqual({ kind: 'ops-health' })
    expect(page.status).toBe('idle')

    page.dispatchEvent(new CustomEvent('mn-ops-health-copy-json', {
      detail: { snapshot: { overall_status: 'ok', generated_at: '2026-06-23T00:00:00Z' } },
      bubbles: true,
      composed: true,
    }))
    await Promise.resolve()
    expect(copied[0]).toContain('"overall_status": "ok"')

    page.dispatchEvent(new CustomEvent('mn-ops-health-back', { bubbles: true, composed: true }))
    expect(closed).toEqual([{ kind: 'ops-health' }])

    mount!.destroy()
    host.remove()
  })

  it('loads and refreshes ops-health snapshots through the shell service', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let calls = 0

    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/ops-health'),
      opsHealthPollIntervalMs: null,
      opsHealthService: {
        load: async () => ({
          overall_status: ++calls === 1 ? 'ok' : 'degraded',
          generated_at: `2026-07-10T00:00:0${calls}Z`,
        }),
      },
    })

    await mount!.ready
    const page = host.querySelector('mn-ops-health-page') as MnOpsHealthPage
    await page.updateComplete
    expect(page.status).toBe('ready')
    expect(page.snapshot?.overall_status).toBe('ok')

    page.dispatchEvent(new CustomEvent('mn-ops-health-refresh', { bubbles: true, composed: true }))
    await Promise.resolve()
    await page.updateComplete
    expect(calls).toBe(2)
    expect(page.status).toBe('ready')
    expect(page.snapshot?.overall_status).toBe('degraded')

    mount!.destroy()
    host.remove()
  })

  it('surfaces ops-health loader failures without rejecting route readiness', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mount = mountOrganismAppRoute(host, {
      location: new URL('https://example.test/ops-health'),
      opsHealthPollIntervalMs: null,
      opsHealthService: {
        load: async () => { throw new Error('operator endpoint unavailable') },
      },
    })

    await mount!.ready
    const page = host.querySelector('mn-ops-health-page') as MnOpsHealthPage
    await page.updateComplete
    expect(page.status).toBe('error')
    expect(page.error).toBe('operator endpoint unavailable')

    mount!.destroy()
    host.remove()
  })
})
