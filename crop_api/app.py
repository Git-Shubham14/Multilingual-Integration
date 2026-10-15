# Crop recommendation API (Module 2, Phase 2 - rule engine only, no LLM, no weather).
# Run:  python app.py
import json
import os

from flask import Flask, jsonify, request

from rules import load_rules, recommend

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
TALUKAS_FILE = os.path.join(DATA_DIR, "talukas.json")
SOIL_TYPES_FILE = os.path.join(DATA_DIR, "soil_types.json")
PORT = 5003

app = Flask(__name__)

print("Loading crop rules ...")
crop_rules = load_rules()
with open(TALUKAS_FILE, encoding="utf-8") as f:
    talukas = json.load(f)["talukas"]
with open(SOIL_TYPES_FILE, encoding="utf-8") as f:
    soil_types = json.load(f)["soil_types"]
taluka_names = {t["en"].lower() for t in talukas}
soil_type_ids = {s["id"] for s in soil_types}
print(f"Crop rules ready. {len(crop_rules)} crops, {sum(c['verified'] for c in crop_rules)} verified.")


def error(messages, code=400):
    if isinstance(messages, str):
        messages = [messages]
    return jsonify({"success": False, "errors": messages}), code


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "crops": len(crop_rules),
        "verified_crops": sum(c["verified"] for c in crop_rules),
    })


@app.get("/talukas")
def get_talukas():
    return jsonify({"talukas": talukas})


@app.get("/soil-types")
def get_soil_types():
    return jsonify({"soil_types": soil_types})


@app.post("/recommend-crop")
def recommend_crop():
    body = request.get_json(silent=True)
    if body is None:
        return error("Send a JSON body.")

    errors = []

    taluka = body.get("taluka")
    if not taluka or taluka.lower() not in taluka_names:
        errors.append(f"Unknown taluka '{taluka}'.")

    sowing_month = body.get("sowing_month")
    if not isinstance(sowing_month, int) or not (1 <= sowing_month <= 12):
        errors.append("sowing_month must be a number from 1 to 12.")

    irrigation = body.get("irrigation")
    if irrigation not in ("yes", "no"):
        errors.append("irrigation must be 'yes' or 'no'.")

    soil = body.get("soil") or {}
    ph = soil.get("ph")
    if ph is not None and not (0 <= ph <= 14):
        errors.append("soil.ph must be between 0 and 14.")

    soil_type = body.get("soil_type")
    if soil_type is not None and soil_type not in soil_type_ids:
        errors.append(f"Unknown soil_type '{soil_type}'.")

    if errors:
        return error(errors)

    previous_crop = body.get("previous_crop")
    recommendations = recommend(
        taluka=taluka,
        sowing_month=sowing_month,
        irrigation=irrigation,
        previous_crop=previous_crop,
        soil=soil,
        soil_type=soil_type,
        rules=crop_rules,
    )
    return jsonify({"success": True, "recommendations": recommendations, "source": "rules"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=False)
