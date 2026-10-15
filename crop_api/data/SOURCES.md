# Sources for crop_rules.json

## ICAR-CRIDA Agriculture Contingency Plan, Nashik district (2011)

- Document: "District Agricultural Contingency Plan, Nashik", prepared under
  ICAR-CRIDA with MPKV Rahuri, 2011.
- Link: http://icar-crida.res.in/CP/Maharastra/MPKVV,%20Rahuri/MH7-NASIK%2031.03.2011.pdf
- Year: 2011

Every `source` entry in `crop_rules.json` that reads `"ICAR 2011 sec X.Y"`
points to a section number inside this document. `verified: true` is only
set for a crop when its sowing window (`sowing_months`) is confirmed by
the plan; crops with `verified: false` have some fields from the plan
(irrigation, soil type, season) but no confirmed sowing month yet.

## What is filled vs. still missing

| Field          | Filled from ICAR 2011? | Notes |
|----------------|-------------------------|-------|
| `season`       | Partial | Set for bajra, wheat, maize, onion_kharif, onion_rabi, chickpea, paddy, groundnut, nagli, soybean. Null for cabbage, sugarcane, grape, pomegranate, tomato (plan does not state a single kharif/rabi/summer season for these). |
| `sowing_months`| Partial | Only bajra, wheat, maize, onion_kharif, onion_rabi, paddy, nagli (the 7 `verified: true` crops). Null for everything else. |
| `irrigation`   | Yes, for all 15 crops | rainfed / required / optional, from sec 1.7 / 1.12. |
| `soil_types`   | Partial | Null for soybean (plan gives no soil preference in sec 1.7). |
| `good_after`   | Partial | Only chickpea and onion_rabi (good after maize, sec 2.1.2). |
| `talukas`      | Not filled | Plan does not break recommendations down by taluka; stays null for every crop. |
| `ph_min`/`ph_max` | Not filled | Plan does not give numeric pH ranges; needs Soil Health Card data instead. |
| `avoid_after`  | Not filled | Plan does not list rotation crops to avoid, only "good after" pairs. |

Still needed (tracked in the main `CLAUDE.md`): Soil Health Card data for
pH ranges, taluka-level breakdowns, and verification of the other 8 crops'
sowing windows.

## Open-Meteo (weather + geocoding)

- Service: Open-Meteo, https://open-meteo.com -- free, no API key needed.
- Geocoding API (`geocoding-api.open-meteo.com/v1/search`) is used once,
  by `scripts/fetch_taluka_coords.py`, to look up each taluka headquarters
  town's latitude/longitude. Results are only accepted if `country_code`
  is `IN`, `admin1` is `Maharashtra`, `admin2` is `Nashik`, and `admin3`
  names the taluka itself (or a known alternate spelling) -- otherwise a
  same-named place in a different district or taluka could be saved by
  mistake. Kalwan, Chandwad and Deola needed an alternate spelling
  (Kalvan, Chandor, Devla) before a real match showed up; all 15 talukas
  are resolved as of this phase.
- Forecast API (`api.open-meteo.com/v1/forecast`) is called per request by
  `weather.py`, using each taluka's saved coordinates, to get current
  conditions plus 14 days of past rainfall and a 7-day forecast. Cached
  in memory for 1 hour per taluka. Weather is a soft signal only: if the
  API is slow, down, or returns something unexpected, `get_weather()`
  returns `None` and the recommendation still goes through without it.

### ICAR dry spell definition

- Source: ICAR 2011 sec 2.1.1 -- a kharif sowing window is considered a
  "dry spell" when there has been less than 2.5 mm of rain over the
  preceding 2 weeks.
- `rules.py` uses this only as a soft warning (`dry_spell` reason, -10
  score) for a kharif crop in its own sowing month; it never removes a
  crop from the results, and it is skipped entirely when weather data is
  unavailable.
