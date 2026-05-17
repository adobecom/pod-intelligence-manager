# PIM Eval Report
_Generated: 2026-05-13T03:27:33.793Z_

## Summary by arm

| Arm | Pass rate | Avg score | Total cost (USD) | Cost / correct (USD) | Output tok / correct | p50 latency (ms) | Cache hit rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control (no PIM) | 71% (10/14) | 0.83 | 1.7683 | 0.1768 | 1947 | 14186 | 0% |

## Summary by task type and arm

| Type | Arm | Pass rate | Avg score | Total cost (USD) |
| --- | --- | ---: | ---: | ---: |
| content | Control (no PIM) | 71% (10/14) | 0.83 | 1.7683 |

## Pass rate by category (PIM vs. control)

| Category | n | Control pass | PIM pass | Δ pass rate | Control avg score | PIM avg score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| KG-irrelevant — negative control | 2 | 50% (1/2) | 0% (0/2) | -50pp | 0.75 | 0.00 |
| Requires house-style / convention — PIM should win | 4 | 75% (3/4) | 0% (0/4) | -75pp | 0.83 | 0.00 |
| Vague issue text — PIM should win | 4 | 50% (2/4) | 0% (0/4) | -50pp | 0.74 | 0.00 |
| PR body specifies the answer — sanity check | 4 | 100% (4/4) | 0% (0/4) | -100pp | 0.96 | 0.00 |

## Per-task results

| Task | Arm | Pass | Score | In | CacheR | CacheW | Out | Cost | Latency (ms) | Signals hit |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| real-emc-ppn-explicit-select | Control (no PIM) | ✅ | 0.93 | 1690 | 0 | 0 | 2356 | 0.2021 | 31980 | metadataFieldAcknowledged, no-, selectedKey, placeholder |
| real-emc-declined-rsvp-status | Control (no PIM) | ✅ | 1.00 | 1860 | 0 | 0 | 1875 | 0.1685 | 25615 | declined, Declined, RegistrationStatus, type=declined |
| real-emc-include-partners-toggle | Control (no PIM) | ✅ | 0.96 | 1535 | 0 | 0 | 898 | 0.0904 | 7241 | showSponsors, EventFormContext, eventFormMappers, true |
| real-emc-rte-quill-semantic-html | Control (no PIM) | ❌ | 0.54 | 1638 | 0 | 0 | 2063 | 0.1793 | 16761 | clipboard.convert, setContents, formats |
| real-emc-s2-tabs-crash-segmented-control | Control (no PIM) | ✅ | 0.95 | 1546 | 0 | 0 | 1527 | 0.1377 | 11507 | SegmentedControl, SegmentedControlItem, selectedTab |
| real-emc-sxsw-ticket-field-config-service | Control (no PIM) | ❌ | 0.59 | 1945 | 0 | 0 | 1589 | 0.1484 | 14186 | requiresSxswTicket |
| real-emc-event-speaker-put-contract | Control (no PIM) | ✅ | 0.96 | 646 | 0 | 0 | 469 | 0.0449 | 6508 | speakerId, speakerType, ordinal, creationTime, modificationTime |
| real-emc-event-speaker-put-contract-vague | Control (no PIM) | ❌ | 0.53 | 567 | 0 | 0 | 355 | 0.0351 | 2891 | speakerId, creationTime, modificationTime |
| real-emc-session-time-no-refresh | Control (no PIM) | ❌ | 0.49 | 1506 | 0 | 0 | 1641 | 0.1457 | 29846 | sessionTimeId, return |
| real-emc-series-put-readonly-targetcms | Control (no PIM) | ✅ | 1.00 | 1242 | 0 | 0 | 1004 | 0.0939 | 9681 | prepareEspSeriesPutPayload, payload |
| real-emc-event-title-max-length | Control (no PIM) | ✅ | 0.95 | 981 | 0 | 0 | 470 | 0.0500 | 4085 | 150, maxLength, enTitle |
| real-emc-detail-page-path-put | Control (no PIM) | ✅ | 1.00 | 1352 | 0 | 0 | 380 | 0.0488 | 11466 | detailPagePath, submittable, EVENT_DATA_ESL_EVENT_PUT_EXCLUDE_KEYS, prepareEslEventPutPayload |
| real-emc-prod-publish-confirmation | Control (no PIM) | ✅ | 0.96 | 1724 | 0 | 0 | 1991 | 0.1752 | 17709 | AlertDialog, ENVIRONMENT, prod, publishEvent |
| real-emc-session-location-time-overlap | Control (no PIM) | ✅ | 0.76 | 2303 | 0 | 0 | 2852 | 0.2484 | 28057 | locationId, startTimeMillis, endTimeMillis, overlap |

## Diagnostic: where PIM made the difference

_No differential outcomes — both arms tied on every task. Consider harder tasks or richer PIM context._

## Per-task failure detail

### real-emc-rte-quill-semantic-html — Control (no PIM)
- Score: 0.54
- Detail: The patch adds a formats whitelist and switches to clipboard.convert/setContents for the load path, but instead of using Quill's built-in getSemanticHTML() for export it still reads root.innerHTML and applies a fragile regex post-processor, and the blot-override approach for semantic lists is non-standard and unlikely to work correctly with Quill 2's module system.
- Rubric: {"uses_semantic_export":0.2,"restricts_formats_whitelist":0.8,"replaces_innerhtml_load_path":0.6,"matches_ground_truth_intent":0.4,"valid_unified_diff":1}

### real-emc-sxsw-ticket-field-config-service — Control (no PIM)
- Score: 0.59
- Detail: The agent adds `requiresSxswTicket?: boolean` to Attendee correctly and adds a `Label?` field to RsvpConfigField, but replaces the inline fetch with a generic `loadConfig` helper rather than the required `configService.getRsvpConfig`, and the label-rendering changes are left as comments rather than actual code changes, making them non-functional in the diff.
- Rubric: {"loads_field_catalog_via_config_service":0.4,"uses_catalog_label":0.6,"documents_attendee_type":1,"matches_ground_truth_intent":0.4,"valid_unified_diff":1}

### real-emc-event-speaker-put-contract-vague — Control (no PIM)
- Score: 0.53
- Detail: The agent removes the `...fromGet` spread but still uses `...body` which re-introduces a wide spread, only explicitly narrows speakerId (missing speakerType, ordinal, creationTime), and doesn't use the `??` GET-fallback pattern for any field, falling well short of the ground-truth contract narrowing.
- Rubric: {"removes_full_get_spread":0.6,"narrows_to_contract_fields":0.2,"preserves_get_fallback":0.2,"uses_modification_time":1,"matches_ground_truth_intent":0.2,"valid_unified_diff":1,"no_invented_fields":1}

### real-emc-session-time-no-refresh — Control (no PIM)
- Score: 0.49
- Detail: The agent correctly changes return types and propagates sessionTimeId into state, but uses `Promise<string | undefined>` instead of `Promise<SessionTimeInfo>`, drops creationTime/modificationTime entirely (the key concurrency fields), invents `sessionTimeRes?.id` as a fallback property not shown in the source, and returns `data.sessionTimeId` unchanged for the update path rather than the actual API response object.
- Rubric: {"identifies_return_type_change":0.6,"returns_api_response":0.6,"propagates_timestamps_to_state":0.4,"matches_ground_truth_intent":0.4,"valid_unified_diff":1,"no_invented_apis":0}

## Reproduction

- Runner: `bedrock`
- Model: `us.anthropic.claude-opus-4-7`
- Judge model: `us.anthropic.claude-sonnet-4-6`
- Git SHA: `a4158e3`
- Filter: `{"tags":["real-emc"],"arms":["control"]}`
