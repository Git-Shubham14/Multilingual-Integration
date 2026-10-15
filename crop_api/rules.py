# Pure-Python rule engine for crop recommendation (Module 2, Phase 2).
# No Flask, no I/O here, so it is easy to unit test.
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_RULES_FILE = os.path.join(BASE_DIR, "data", "crop_rules.json")

STARTING_SCORE = 100
PH_PENALTY = 20
UNVERIFIED_PENALTY = 10
GOOD_ROTATION_BONUS = 15
MAX_RESULTS = 3


def load_rules(path=DEFAULT_RULES_FILE):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data["crops"]


def recommend(taluka, sowing_month, irrigation, previous_crop, soil=None, soil_type=None, rules=None):
    if rules is None:
        rules = load_rules()
    soil = soil or {}

    results = []
    for crop in rules:
        # Hard rules: fail one and the crop is dropped, not scored.
        talukas = crop.get("talukas")
        if talukas is not None and talukas != "all" and taluka not in talukas:
            continue

        sowing_months = crop.get("sowing_months")
        if sowing_months is not None and sowing_month not in sowing_months:
            continue

        if crop.get("irrigation") == "required" and irrigation == "no":
            continue

        avoid_after = crop.get("avoid_after")
        if avoid_after is not None and previous_crop in avoid_after:
            continue

        soil_types = crop.get("soil_types")
        if soil_types is not None and soil_type is not None and soil_type not in soil_types:
            continue

        # Soft rules: crop stays, score changes, reason explains why.
        score = STARTING_SCORE
        reasons = []

        ph = soil.get("ph")
        ph_min, ph_max = crop.get("ph_min"), crop.get("ph_max")
        if ph is not None and ph_min is not None and ph_max is not None:
            if ph_min <= ph <= ph_max:
                reasons.append({"code": "ph_ok", "text": f"Soil pH {ph} is within {ph_min}-{ph_max}"})
            else:
                score -= PH_PENALTY
                reasons.append({"code": "ph_out_of_range", "text": f"Soil pH {ph} is outside {ph_min}-{ph_max}"})

        if sowing_months is None:
            reasons.append({"code": "sowing_unknown", "text": "Sowing window not verified"})

        good_after = crop.get("good_after")
        if good_after is not None and previous_crop in good_after:
            score += GOOD_ROTATION_BONUS
            reasons.append({"code": "good_rotation", "text": f"Good to grow after {previous_crop}"})

        if not crop.get("verified", False):
            score -= UNVERIFIED_PENALTY
            reasons.append({"code": "not_verified", "text": "This crop's data is not verified yet"})

        results.append({
            "id": crop["id"],
            "names": crop.get("names"),
            "score": score,
            "reasons": reasons,
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:MAX_RESULTS]
