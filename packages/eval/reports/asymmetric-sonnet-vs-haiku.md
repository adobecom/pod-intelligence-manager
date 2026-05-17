# PIM Eval Report
_Generated: 2026-05-13T03:14:49.681Z_

## Executive summary

- PIM lifts pass rate by 21pp (71% → 93%, n=14).
- PIM cuts cost-per-correct by 65% ($0.0254 → $0.0089).
- Differential outcomes: 4 tasks where PIM passed and control failed; 1 task where PIM regressed.

## Summary by arm

| Arm | Pass rate | Avg score | Total cost (USD) | Cost / correct (USD) | Output tok / correct | p50 latency (ms) | Cache hit rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control (no PIM) | 71% (10/14) | 0.78 | 0.2539 | 0.0254 | 1397 | 8302 | 0% |
| PIM-full | 93% (13/14) | 0.86 | 0.1151 | 0.0089 | 1118 | 5822 | 85% |

## Summary by task type and arm

| Type | Arm | Pass rate | Avg score | Total cost (USD) |
| --- | --- | ---: | ---: | ---: |
| content | Control (no PIM) | 71% (10/14) | 0.78 | 0.2539 |
| content | PIM-full | 93% (13/14) | 0.86 | 0.1151 |

## Pass rate by category (PIM vs. control)

| Category | n | Control pass | PIM pass | Δ pass rate | Control avg score | PIM avg score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| KG-irrelevant — negative control | 2 | 100% (2/2) | 50% (1/2) | -50pp | 0.83 | 0.74 |
| Requires house-style / convention — PIM should win | 4 | 75% (3/4) | 100% (4/4) | +25pp | 0.84 | 0.83 |
| Vague issue text — PIM should win | 4 | 50% (2/4) | 100% (4/4) | +50pp | 0.76 | 0.90 |
| PR body specifies the answer — sanity check | 4 | 75% (3/4) | 100% (4/4) | +25pp | 0.70 | 0.92 |

## Per-task results

| Task | Arm | Pass | Score | In | CacheR | CacheW | Out | Cost | Latency (ms) | Signals hit |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| real-emc-ppn-explicit-select | Control (no PIM) | ✅ | 0.89 | 1249 | 0 | 0 | 1461 | 0.0257 | 13863 | metadataFieldAcknowledged, no-, selectedKey, placeholder |
| real-emc-ppn-explicit-select | PIM-full | ✅ | 0.93 | 1164 | 0 | 11415 | 1169 | 0.0213 | 17521 | metadataFieldAcknowledged, no-, selectedKey, placeholder |
| real-emc-declined-rsvp-status | Control (no PIM) | ❌ | 0.00 | 1372 | 0 | 0 | 1223 | 0.0225 | 10133 | declined, Declined, RegistrationStatus |
| real-emc-declined-rsvp-status | PIM-full | ✅ | 0.83 | 1287 | 11415 | 0 | 1314 | 0.0090 | 7150 | declined, Declined, RegistrationStatus |
| real-emc-include-partners-toggle | Control (no PIM) | ✅ | 0.87 | 1057 | 0 | 0 | 535 | 0.0112 | 5817 | showSponsors, EventFormContext, eventFormMappers, true |
| real-emc-include-partners-toggle | PIM-full | ✅ | 0.91 | 972 | 11415 | 0 | 762 | 0.0059 | 5075 | showSponsors, EventFormContext, eventFormMappers, true |
| real-emc-rte-quill-semantic-html | Control (no PIM) | ✅ | 0.76 | 1229 | 0 | 0 | 1839 | 0.0313 | 19725 | getSemanticHTML, clipboard.convert, setContents, formats |
| real-emc-rte-quill-semantic-html | PIM-full | ❌ | 0.58 | 1144 | 11415 | 0 | 1647 | 0.0105 | 8587 | clipboard.convert, setContents, formats |
| real-emc-s2-tabs-crash-segmented-control | Control (no PIM) | ✅ | 0.91 | 1082 | 0 | 0 | 869 | 0.0163 | 7362 | SegmentedControl, SegmentedControlItem, selectedTab |
| real-emc-s2-tabs-crash-segmented-control | PIM-full | ✅ | 0.91 | 997 | 11415 | 0 | 1157 | 0.0079 | 5822 | SegmentedControl, SegmentedControlItem, selectedTab |
| real-emc-sxsw-ticket-field-config-service | Control (no PIM) | ❌ | 0.59 | 1418 | 0 | 0 | 1262 | 0.0232 | 11376 | configService, requiresSxswTicket |
| real-emc-sxsw-ticket-field-config-service | PIM-full | ✅ | 0.76 | 1333 | 11415 | 0 | 1215 | 0.0085 | 7725 | configService, getRsvpConfig, requiresSxswTicket |
| real-emc-event-speaker-put-contract | Control (no PIM) | ✅ | 0.96 | 480 | 0 | 0 | 359 | 0.0068 | 3825 | speakerId, speakerType, ordinal, creationTime, modificationTime |
| real-emc-event-speaker-put-contract | PIM-full | ✅ | 0.96 | 398 | 11075 | 0 | 318 | 0.0031 | 2217 | speakerId, speakerType, ordinal, creationTime, modificationTime |
| real-emc-event-speaker-put-contract-vague | Control (no PIM) | ❌ | 0.63 | 425 | 0 | 0 | 405 | 0.0073 | 4310 | speakerId, creationTime, modificationTime |
| real-emc-event-speaker-put-contract-vague | PIM-full | ✅ | 0.96 | 343 | 11075 | 0 | 405 | 0.0035 | 2771 | speakerId, speakerType, ordinal, creationTime, modificationTime |
| real-emc-session-time-no-refresh | Control (no PIM) | ❌ | 0.58 | 1033 | 0 | 0 | 983 | 0.0178 | 8302 | sessionTimeId, return |
| real-emc-session-time-no-refresh | PIM-full | ✅ | 0.93 | 951 | 11075 | 0 | 1185 | 0.0080 | 5680 | SessionTimeInfo, modificationTime, creationTime, sessionTimeId, return |
| real-emc-series-put-readonly-targetcms | Control (no PIM) | ✅ | 0.92 | 928 | 0 | 0 | 799 | 0.0148 | 6690 | prepareEspSeriesPutPayload, payload |
| real-emc-series-put-readonly-targetcms | PIM-full | ✅ | 0.92 | 846 | 11075 | 0 | 877 | 0.0063 | 4391 | prepareEspSeriesPutPayload, payload |
| real-emc-event-title-max-length | Control (no PIM) | ✅ | 0.95 | 732 | 0 | 0 | 254 | 0.0060 | 3094 | 150, maxLength, enTitle |
| real-emc-event-title-max-length | PIM-full | ✅ | 0.95 | 650 | 11075 | 0 | 375 | 0.0036 | 2874 | 150, maxLength, enTitle |
| real-emc-detail-page-path-put | Control (no PIM) | ✅ | 0.96 | 972 | 0 | 0 | 289 | 0.0073 | 3548 | detailPagePath, submittable, EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS, prepareEslEventPutPayload |
| real-emc-detail-page-path-put | PIM-full | ✅ | 0.78 | 890 | 11075 | 0 | 287 | 0.0034 | 2407 | detailPagePath, submittable, EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS, prepareEslEventPutPayload |
| real-emc-prod-publish-confirmation | Control (no PIM) | ✅ | 0.96 | 1231 | 0 | 0 | 1817 | 0.0309 | 14647 | AlertDialog, ENVIRONMENT, prod, publishEvent |
| real-emc-prod-publish-confirmation | PIM-full | ✅ | 0.73 | 1149 | 11075 | 0 | 1553 | 0.0100 | 8094 | AlertDialog, ENVIRONMENT, prod, publishEvent |
| real-emc-session-location-time-overlap | Control (no PIM) | ✅ | 0.89 | 1580 | 0 | 0 | 1875 | 0.0329 | 18300 | locationId, startTimeMillis, endTimeMillis, overlap |
| real-emc-session-location-time-overlap | PIM-full | ✅ | 0.89 | 1498 | 11075 | 0 | 2269 | 0.0140 | 11702 | locationId, startTimeMillis, endTimeMillis, overlap |

## Diagnostic: where PIM made the difference

### Tasks where PIM-arm passed AND control failed (PIM saves)
- **real-emc-declined-rsvp-status** — control failure: `judge returned unparseable response: Looking at the agent's output carefully:

1. **extends_status_union**: Correctly adds `'declined'` to `RegistrationStatus`. Full marks.

2. **extends_stats_interface**: Adds `declined` field to `Atten`
- **real-emc-sxsw-ticket-field-config-service** — control failure: `The agent adds `requiresSxswTicket` to Attendee correctly and adds a `Label` field to RsvpConfigField, but it uses a generic `loadConfig` wrapper that still hardcodes the event-libs URL rather than routing through `configService.getRsvpConfig(id)` as required; the label-rendering change is only shown in comments rather than in actual component code, so the runtime behavior is not actually changed.`
- **real-emc-event-speaker-put-contract-vague** — control failure: `The patch correctly removes the `...fromGet` spread and preserves GET-fallback and modificationTime, but invents fields (firstName, lastName, email, bio, jobTitle, company) not in the speaker contract, missing the correct contract fields (speakerType, ordinal, creationTime) from the ground truth.`
- **real-emc-session-time-no-refresh** — control failure: `The agent correctly changes return types from void and propagates sessionTimeId into state, but invents a non-existent `.id` field on the API response (should cast to SessionTimeInfo), omits creationTime/modificationTime from the returned shape and state updates, and the try/catch block restructuring is inconsistent with the diff context.`

### Tasks where control passed AND PIM-arm failed (PIM regressions)
- **real-emc-rte-quill-semantic-html** — PIM failure: `The patch correctly adds a formats whitelist and replaces innerHTML assignment with clipboard.convert+setContents on the load path, but critically fails the semantic export requirement by still reading root.innerHTML in the text-change handler (applying a regex post-process instead of using getSemanticHTML()), which diverges from the ground truth's intent of using Quill's built-in semantic serialization; additionally, useMemo is misused for functions with side effects and the diff has some structural issues.`

## Per-task failure detail

### real-emc-declined-rsvp-status — Control (no PIM)
- Score: 0.00
- Detail: judge returned unparseable response: Looking at the agent's output carefully:

1. **extends_status_union**: Correctly adds `'declined'` to `RegistrationStatus`. Full marks.

2. **extends_stats_interface**: Adds `declined` field to `Atten

### real-emc-sxsw-ticket-field-config-service — Control (no PIM)
- Score: 0.59
- Detail: The agent adds `requiresSxswTicket` to Attendee correctly and adds a `Label` field to RsvpConfigField, but it uses a generic `loadConfig` wrapper that still hardcodes the event-libs URL rather than routing through `configService.getRsvpConfig(id)` as required; the label-rendering change is only shown in comments rather than in actual component code, so the runtime behavior is not actually changed.
- Rubric: {"loads_field_catalog_via_config_service":0.4,"uses_catalog_label":0.6,"documents_attendee_type":1,"matches_ground_truth_intent":0.4,"valid_unified_diff":1}

### real-emc-event-speaker-put-contract-vague — Control (no PIM)
- Score: 0.63
- Detail: The patch correctly removes the `...fromGet` spread and preserves GET-fallback and modificationTime, but invents fields (firstName, lastName, email, bio, jobTitle, company) not in the speaker contract, missing the correct contract fields (speakerType, ordinal, creationTime) from the ground truth.
- Rubric: {"removes_full_get_spread":1,"narrows_to_contract_fields":0.2,"preserves_get_fallback":0.8,"uses_modification_time":1,"matches_ground_truth_intent":0.4,"valid_unified_diff":1,"no_invented_fields":0}

### real-emc-session-time-no-refresh — Control (no PIM)
- Score: 0.58
- Detail: The agent correctly changes return types from void and propagates sessionTimeId into state, but invents a non-existent `.id` field on the API response (should cast to SessionTimeInfo), omits creationTime/modificationTime from the returned shape and state updates, and the try/catch block restructuring is inconsistent with the diff context.
- Rubric: {"identifies_return_type_change":0.6,"returns_api_response":0.6,"propagates_timestamps_to_state":0.6,"matches_ground_truth_intent":0.6,"valid_unified_diff":1,"no_invented_apis":0}

### real-emc-rte-quill-semantic-html — PIM-full
- Score: 0.58
- Detail: The patch correctly adds a formats whitelist and replaces innerHTML assignment with clipboard.convert+setContents on the load path, but critically fails the semantic export requirement by still reading root.innerHTML in the text-change handler (applying a regex post-process instead of using getSemanticHTML()), which diverges from the ground truth's intent of using Quill's built-in semantic serialization; additionally, useMemo is misused for functions with side effects and the diff has some structural issues.
- Rubric: {"uses_semantic_export":0.2,"restricts_formats_whitelist":0.8,"replaces_innerhtml_load_path":0.8,"matches_ground_truth_intent":0.4,"valid_unified_diff":1}

## Reproduction

- Runner: `bedrock`
- Model: `us.anthropic.claude-sonnet-4-6`
- Judge model: `us.anthropic.claude-sonnet-4-6`
- Git SHA: `a4158e3`
- Filter: `{"tags":["real-emc"]}`
