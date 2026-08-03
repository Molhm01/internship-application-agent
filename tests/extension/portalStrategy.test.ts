import { describe, expect, it } from 'vitest';
import {
  PORTAL_STRATEGIES,
  accountPreferencesSchema,
  classifyPage,
  navigationActivationResultSchema,
  portalRoutes,
  selectPortalRoute,
  activateNavigationMessageSchema,
  type NavigationState,
} from '@internship-agent/shared';
import { activateNavigation } from '../../extension/src/content/navigate.js';

/**
 * The agent picking a route off an employer portal.
 *
 * Two properties matter more than any single case here: a saved strategy is
 * honoured without stopping to ask, and no strategy whatsoever can produce a
 * click on a final Submit or a way past a CAPTCHA.
 */

function navigation(overrides: Partial<NavigationState> = {}): NavigationState {
  return {
    kind: 'login',
    requiresCredentials: true,
    actions: [
      { intent: 'login', label: 'Login', selector: '#loginButton', endsApplication: false },
      { intent: 'create_account', label: 'New User', selector: '#newUser', endsApplication: false },
      {
        intent: 'apply_as_guest',
        label: 'Apply as Guest',
        selector: '#guest',
        endsApplication: false,
      },
    ],
    ...overrides,
  };
}

describe('portal strategy selection', () => {
  it('Prefer guest selects Apply as Guest', () => {
    const decision = selectPortalRoute(navigation(), 'prefer_guest');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    expect(decision.action.intent).toBe('apply_as_guest');
    expect(decision.action.selector).toBe('#guest');
  });

  it('Prefer guest falls back to Create Account when the portal offers no guest route', () => {
    const withoutGuest = navigation({
      actions: navigation().actions.filter((action) => action.intent !== 'apply_as_guest'),
    });
    const decision = selectPortalRoute(withoutGuest, 'prefer_guest');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    expect(decision.action.intent).toBe('create_account');
    expect(decision.reason).toMatch(/no guest route/i);
  });

  it('Create account strategy selects the New User / Create Account control', () => {
    const decision = selectPortalRoute(navigation(), 'create_when_required');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    expect(decision.action.intent).toBe('create_account');
    // The page's own wording is carried through, so the executor clicks the
    // control the ATS actually rendered.
    expect(decision.action.label).toBe('New User');
  });

  it('Existing account strategy selects Login', () => {
    const decision = selectPortalRoute(navigation(), 'use_existing_account');
    expect(decision.decision).toBe('act');
    if (decision.decision !== 'act') throw new Error('unreachable');
    expect(decision.action.intent).toBe('login');
  });

  it('Ask every time shows the three choices and takes none of them', () => {
    const decision = selectPortalRoute(navigation(), 'always_ask');
    expect(decision.decision).toBe('ask');
    if (decision.decision !== 'ask') throw new Error('unreachable');
    expect(decision.options.map((option) => option.intent).sort()).toEqual([
      'apply_as_guest',
      'create_account',
      'login',
    ]);
  });

  it('asks when no strategy has been saved, and names the setting', () => {
    const decision = selectPortalRoute(navigation(), undefined);
    expect(decision.decision).toBe('ask');
    expect(decision.reason).toMatch(/options/i);
  });

  it('offers each route once when a portal renders it twice', () => {
    const duplicated = navigation({
      actions: [
        ...navigation().actions,
        { intent: 'login', label: 'Sign in', selector: '#headerLogin', endsApplication: false },
      ],
    });
    expect(portalRoutes(duplicated)).toHaveLength(3);
  });

  it('never treats a final Submit as a route, whatever the strategy', () => {
    const withSubmit = navigation({
      actions: [
        ...navigation().actions,
        {
          intent: 'final_submit',
          label: 'Submit Application',
          selector: '#submit',
          endsApplication: true,
        },
      ],
    });
    expect(portalRoutes(withSubmit).some((route) => route.endsApplication)).toBe(false);
    for (const strategy of PORTAL_STRATEGIES) {
      const decision = selectPortalRoute(withSubmit, strategy);
      if (decision.decision === 'act') {
        expect(decision.action.endsApplication).toBe(false);
        expect(decision.action.intent).not.toBe('final_submit');
      }
      if (decision.decision === 'ask') {
        expect(decision.options.every((option) => !option.endsApplication)).toBe(true);
      }
    }
  });
});

describe('challenges pause every strategy', () => {
  const challenges: Array<[string, string]> = [
    ['CAPTCHA', 'Please complete the reCAPTCHA below to continue.'],
    ['MFA', 'Enter the verification code we sent to your device.'],
    [
      'email verification',
      'Check your email and click the confirmation link to activate your account.',
    ],
  ];

  for (const [name, bodyText] of challenges) {
    it(`stops on ${name} rather than taking a route`, () => {
      const page = classifyPage({
        url: 'https://careers2-quanta.icims.com/jobs/1/login',
        title: 'Sign in',
        bodyText,
        fields: [],
        controls: [
          { label: 'Apply as Guest', selector: '#guest' },
          { label: 'New User', selector: '#newUser' },
        ],
      });
      expect(page.kind).toBe('blocked');
      for (const strategy of PORTAL_STRATEGIES) {
        const decision = selectPortalRoute(page, strategy);
        expect(decision.decision).toBe('blocked');
        expect(decision.reason).toMatch(/yourself|your inbox/i);
      }
    });
  }
});

describe('activating a route in the page', () => {
  const PORTAL_URL = 'https://careers2-quanta.icims.com/jobs/1/login';

  function page(html: string): Document {
    return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  }

  const at = (): string => PORTAL_URL;

  it('clicks the route and reports where the page ended up', async () => {
    const document = page('<button id="guest">Apply as Guest</button>');
    let clicked = false;
    document.querySelector('#guest')!.addEventListener('click', () => {
      clicked = true;
    });

    const result = await activateNavigation(
      { type: 'ACTIVATE_NAVIGATION', intent: 'apply_as_guest', selector: '#guest' },
      document,
      at,
    );

    expect(clicked).toBe(true);
    expect(result.status).toBe('activated');
    expect(navigationActivationResultSchema.parse(result)).toBeTruthy();
  });

  it('refuses a control whose words no longer match the requested route', async () => {
    // The selector survived a re-render but now points at something else.
    const document = page('<button id="guest">Submit Application</button>');
    let clicked = false;
    document.querySelector('#guest')!.addEventListener('click', () => {
      clicked = true;
    });

    const result = await activateNavigation(
      { type: 'ACTIVATE_NAVIGATION', intent: 'apply_as_guest', selector: '#guest' },
      document,
      at,
    );

    expect(result.status).toBe('refused');
    expect(clicked).toBe(false);
  });

  it('cannot be asked to click a final Submit — the message schema has no such intent', () => {
    const parsed = activateNavigationMessageSchema.safeParse({
      type: 'ACTIVATE_NAVIGATION',
      intent: 'final_submit',
      selector: '#submit',
    });
    expect(parsed.success).toBe(false);
    // And the three that do validate are all routes.
    for (const intent of ['apply_as_guest', 'create_account', 'login']) {
      expect(
        activateNavigationMessageSchema.safeParse({
          type: 'ACTIVATE_NAVIGATION',
          intent,
          selector: '#x',
        }).success,
      ).toBe(true);
    }
  });

  it('refuses a missing control instead of clicking whatever is nearby', async () => {
    const result = await activateNavigation(
      { type: 'ACTIVATE_NAVIGATION', intent: 'login', selector: '#gone' },
      page('<button id="other">Login</button>'),
      at,
    );
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toMatch(/no longer on this page/i);
  });
});

describe('the strategy list itself', () => {
  it('has the four routes the options page offers, and no duplicates', () => {
    expect([...PORTAL_STRATEGIES]).toEqual([
      'prefer_guest',
      'create_when_required',
      'use_existing_account',
      'always_ask',
    ]);
    expect(new Set(PORTAL_STRATEGIES).size).toBe(PORTAL_STRATEGIES.length);
  });

  it('is the same list an application bundle accepts', () => {
    // One enum, two consumers. `accountPreferencesSchema` used to re-spell this
    // list, so a strategy the extension understood was rejected the moment it
    // arrived inside a bundle — which reads as the website having sent nothing.
    for (const strategy of PORTAL_STRATEGIES) {
      const parsed = accountPreferencesSchema.safeParse({ portalStrategy: strategy });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.portalStrategy).toBe(strategy);
    }
    expect(accountPreferencesSchema.safeParse({ portalStrategy: 'invent_one' }).success).toBe(
      false,
    );
  });
});
