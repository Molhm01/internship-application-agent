# SuccessFactors Agent control-classification root cause

## Production path

The SuccessFactors adapter does not have a separate field scanner. The active
path is:

1. `extension/src/scanner/adapters.ts` — `BrowserAdapter.scan()` calls
   `scanDom()` for the `successfactors` adapter.
2. `extension/src/scanner/domScanner.ts` — `scanOnce()` collects every matching
   DOM node, and `fieldFromElements()` calls `inferType()`.
3. Before this repair, the inner editable/display `<input>` was kept as the
   field node. `isTypedTextControl()` asked `answersFromList()` only about that
   input's own attributes. With the list semantics on an associated sibling or
   outer trigger, it returned `true` for “typed text control,” so `inferType()`
   returned `text`.
4. The normalized `DetectedField` therefore had the inner input selector,
   `fieldType: text`, `metadata.tagName: input`, and no observed options. Its
   label/canonical intent could still be correct; normalization of the question
   did not repair normalization of the control.
5. `extension/src/agent/pageObserver.ts` — `observePage()` resolved that inner
   selector and passed the input to `interactionTypeOf()`. The old input branch
   again considered only attributes on that node, fell through, and returned
   `TEXT_INPUT`.
6. `extension/src/agent/agentDecision.ts` treated the known, empty field as
   ordinary text and returned `type`.
7. `extension/src/agent/agentSafety.ts` correctly allowed `type` for the
   authoritative type it had been given (`TEXT_INPUT`).
8. `extension/src/agent/agentToolExecutor.ts` ran the native text setter. The
   SuccessFactors widget did not commit an option, the form remained required,
   and fresh verification reported `REJECTED_BY_FORM`.

That is the first incorrect transition seen in the live trace:

`SuccessFactors composite choice widget -> inner input DetectedField -> TEXT_INPUT`.

## DOM evidence and ownership

The relevant evidence is structural, not the field name:

- one field wrapper contains an editable/display input;
- the same smallest composite contains an associated trigger with
  `role=combobox`, list/menu `aria-haspopup`, `aria-expanded`, and/or
  `aria-controls`/`aria-owns` pointing at an option popup;
- the input and trigger share the field's accessible label, or an unlabelled
  display/search input and the choice trigger are unique in the smallest field
  composite;
- the option popup exposes listbox/menu option structure when rendered;
- on an adapter-confirmed SuccessFactors document, legacy
  `aria-haspopup=true` is accepted as the vendor's menu declaration.

The live Agent Run Trace does not contain raw employer HTML, so this repair does
not pretend to quote markup that was not exported. The regression fixture
`tests/fixtures/lab/successfactors-composite-controls.html` records the exact
structural evidence above without depending on “State/Province,” “Education
Type,” or “Area of Study” as classifier inputs.

## Why the inner node won

`CONTROL_SELECTOR` necessarily includes inputs. Before this repair there was no
general semantic-owner step between discovery and `inferType()`. The existing
duplicate suppression handled an input strictly inside a `[role=combobox]` and
some React Select roots, but it did not join an input to an associated sibling
trigger. Consequently the scanner minted the field selector from the input,
and every later layer faithfully re-resolved and classified that same inner
node.

## Repair

`extension/src/scanner/controlOwnership.ts` now resolves one logical owner
before classification:

- a native select owns itself;
- an ordinary input with no list owner remains an input;
- a composite input resolves to its associated outer choice trigger;
- a genuine search input requires explicit search/list evidence and is kept as
  the searchable part of the choice widget;
- native or text-backed date evidence wins before a nearby popup/calendar
  affordance.

`scanOnce()` canonicalizes candidates through that owner before
`fieldFromElements()`. `interactionTypeOf()` and `resolveTrigger()` use the same
ownership rule, so the observed type, validator, and existing dropdown executor
cannot disagree about which node is the field.

The resulting contract is:

`CUSTOM_SELECT/SEARCHABLE_COMBOBOX -> open_dropdown -> fresh option observation -> select_option(actual optionId) -> fresh committed-value verification`.

The Agent `type` tool remains legal only for `TEXT_INPUT`/`TEXTAREA`. It is
rejected with `WRONG_TOOL_FOR_CONTROL_TYPE` on every choice parent. The existing
dropdown executor may type a query only into the explicitly identified internal
search input after it opens a `SEARCHABLE_COMBOBOX`; that internal operation
does not relax the Agent tool contract for the parent.

## Failure feedback

The secondary failure was literal in `agentLoop.ts`: both failed-action history
records set `modelReceivedFailureFeedback: false`, and the next `DecisionInput`
and `AgentChoiceRequest` had no failure member. The model therefore saw the same
page as if the previous attempt had never happened.

The next decision now receives a sanitized `previousFailure` containing only
the tool, employer field label/logical key, error code, state category, page
change boolean, control type, and strategy guidance. It contains no attempted or
stored value. If a model repeats the same failed choice action against unchanged
state, the loop substitutes the deterministic dropdown recovery. If that would
repeat the failed action too, the field is handed to the user. The existing
three-failure safety breaker remains in place.
