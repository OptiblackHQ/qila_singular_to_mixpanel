# Singular → Mixpanel Integration

## Overview

This server-side integration captures attribution data from Singular and sends it to Mixpanel as user properties and events. It provides accurate attribution tracking for both iOS and Android users.

---

## Key Features

| Feature | Description |
|---|---|
| ✅ Attribution Capture | Captures attribution data from Singular postbacks |
| ✅ User Properties | Sets user properties in Mixpanel with attribution details |
| ✅ Event Tracking | Tracks attribution events (install, reengagement, login) |
| ✅ Identity Linking | Links device IDs to user IDs automatically |
| ✅ Organic & Paid | Handles both organic and paid installs |
| ✅ Reliability | Retry logic ensures data delivery |

---

## Why Server-Side?

| Benefit | Details |
|---|---|
| **Accuracy** | No data loss from SDK issues |
| **Debugging** | Complete visibility via CloudWatch logs |
| **Flexibility** | Easy to modify field mappings |
| **Reliability** | Retry logic ensures data delivery |
| **Control** | Independent of Singular's direct integration |

---

## Architecture

### Data Flow

```
User Installs App
       ↓
Singular SDK (in app)
       ↓
Singular Platform (processes attribution)
       ↓
Singular Postback → API Gateway
       ↓
AWS Lambda Function
       ↓
Mixpanel API
       ↓
Mixpanel User Profile (updated)
```

---

## Event Mapping

| Singular `event_name` | Condition | Mixpanel Event |
|---|---|---|
| `__start__` | `is_reengagement === 1` | `reengagement` |
| `__start__` | `is_reengagement !== 1` | `install` |
| `login_completed_event` | — | `attribution_received` |
| `sign_up_completed_event` | — | `attribution_received` |
| *(anything else)* | — | passed through as-is |
| *(missing / empty)* | — | `unknown_event` |

---

## Field Mapping

| Singular Field | Mixpanel Property |
|---|---|
| `campaign` | `mp_campaign` |
| `network` | `mp_source` |
| `site` | `mp_site` |
| `tracker_name` | `mp_tracker` |
| `aifa` / `gaid` | `gps_adid` |
| `idfa` | `idfa` |
| `idfv` | `idfv` |
| `platform` | `platform` |
| `os_version` | `os_version` |
| `device_brand` | `device_brand` |
| `device_model` | `device_model` |
| `city` | `city` |
| `country` | `country` |
| `app_name` | `app_name` |
| `app_version` | `app_version` |

> All unmapped fields are forwarded automatically with a `$singular_` prefix (e.g. `$singular_click_ip`).

---

## Identity Resolution

The integration resolves user identity in the following priority order:

1. **`MDistinctID`** — Singular Global Property set via Mixpanel SDK *(most accurate)*
2. **`mixpanel_distinct_id`** — Alternate global property key
3. **`user_id`** — Singular's post-login user identifier
4. **`aifa` / `gaid` / `idfa` / `idfv`** — Device advertising ID *(fallback)*

> **Note:** Singular sends `{"ValueType": 1}` to represent a null/unset global property. The integration filters these out before identity resolution.

---

## Profile Merging

When an SDK profile already exists in Mixpanel, the integration attempts to merge it with the Singular attribution profile:

```
Singular Profile (attribution data)
           ↓
    $create_alias call
           ↓
SDK Profile (SDK events + attribution)
```

Merge is **skipped** if:
- `MDistinctID` is already present (identity already resolved)
- `MIXPANEL_API_SECRET` is not configured
- SDK profile distinct ID matches the Singular distinct ID

---

## Configuration

| Environment Variable | Required | Description |
|---|---|---|
| `MIXPANEL_TOKEN` | ✅ Yes | Your Mixpanel project token |
| `MIXPANEL_API_SECRET` | ⚠️ Optional | Required for profile merge/query |

---

## Error Handling

| Error | Behaviour |
|---|---|
| No user identifier found | Returns `400` — event dropped |
| Mixpanel API failure | Retried up to `MAX_RETRIES` times with backoff |
| Profile query timeout (5s) | Skips merge, continues with tracking |
| Profile merge failure | Logs error, continues with property set + event track |
| All retries exhausted | Returns `500` |
