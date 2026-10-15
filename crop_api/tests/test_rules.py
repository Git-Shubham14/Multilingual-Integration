# Tests for the rule engine. Uses a small fake rules list here, not the
# real crop_rules.json, so these tests do not depend on Shubham's real data.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rules import recommend  # noqa: E402

FAKE_RULES = [
    {
        "id": "wheat",
        "names": {"en": "Wheat", "mr": "गहू", "hi": "गेहूं", "reviewed": False},
        "talukas": ["Niphad", "Sinnar"],
        "sowing_months": [10, 11],
        "irrigation": "required",
        "ph_min": 6.0,
        "ph_max": 7.5,
        "avoid_after": ["wheat"],
        "source": "test",
        "verified": True,
    },
    {
        "id": "bajra",
        "names": {"en": "Pearl millet", "mr": "बाजरी", "hi": "बाजरा", "reviewed": False},
        "talukas": "all",
        "sowing_months": [6, 7],
        "irrigation": "rainfed",
        "ph_min": None,
        "ph_max": None,
        "avoid_after": None,
        "source": "test",
        "verified": False,
    },
    {
        "id": "onion",
        "names": {"en": "Onion", "mr": "कांदा", "hi": "प्याज", "reviewed": False},
        "talukas": "all",
        "sowing_months": None,
        "irrigation": "optional",
        "ph_min": None,
        "ph_max": None,
        "avoid_after": None,
        "source": "test",
        "verified": True,
    },
]


def test_taluka_hard_rule_removes_crop():
    results = recommend("Malegaon", 11, "yes", None, rules=FAKE_RULES)
    ids = [r["id"] for r in results]
    assert "wheat" not in ids  # Malegaon is not in wheat's taluka list


def test_month_hard_rule_removes_crop():
    results = recommend("Niphad", 3, "yes", None, rules=FAKE_RULES)
    ids = [r["id"] for r in results]
    assert "wheat" not in ids  # month 3 is not in wheat's sowing_months


def test_irrigation_hard_rule_removes_crop():
    results = recommend("Niphad", 11, "no", None, rules=FAKE_RULES)
    ids = [r["id"] for r in results]
    assert "wheat" not in ids  # wheat needs irrigation, farmer has none


def test_avoid_after_hard_rule_removes_crop():
    results = recommend("Niphad", 11, "yes", "wheat", rules=FAKE_RULES)
    ids = [r["id"] for r in results]
    assert "wheat" not in ids  # can't grow wheat right after wheat


def test_ph_soft_rule_lowers_score():
    in_range = recommend("Niphad", 11, "yes", None, soil={"ph": 7.0}, rules=FAKE_RULES)
    out_of_range = recommend("Niphad", 11, "yes", None, soil={"ph": 9.0}, rules=FAKE_RULES)

    wheat_in_range = next(r for r in in_range if r["id"] == "wheat")
    wheat_out_of_range = next(r for r in out_of_range if r["id"] == "wheat")

    assert wheat_out_of_range["score"] < wheat_in_range["score"]
    assert any(r["code"] == "ph_out_of_range" for r in wheat_out_of_range["reasons"])


def test_null_fields_are_skipped_not_treated_as_failure():
    # bajra has every soft/hard field null or "all" except irrigation/months;
    # giving no soil data at all must not remove or penalise it for pH.
    results = recommend("Dindori", 6, "yes", None, rules=FAKE_RULES)
    bajra = next(r for r in results if r["id"] == "bajra")
    assert not any(r["code"].startswith("ph_") for r in bajra["reasons"])


def test_max_three_results():
    many_rules = [dict(FAKE_RULES[2], id=f"crop{i}") for i in range(5)]
    results = recommend("Dindori", 1, "yes", None, rules=many_rules)
    assert len(results) <= 3


def test_empty_list_when_nothing_qualifies():
    results = recommend("Dindori", 1, "yes", None, rules=[FAKE_RULES[0]])
    assert results == []


def test_api_rejects_bad_input():
    from app import app as flask_app

    client = flask_app.test_client()

    bad_taluka = client.post("/recommend-crop", json={
        "taluka": "Nowhere", "sowing_month": 11, "irrigation": "yes",
    })
    assert bad_taluka.status_code == 400
    assert bad_taluka.get_json()["success"] is False

    bad_month = client.post("/recommend-crop", json={
        "taluka": "Niphad", "sowing_month": 13, "irrigation": "yes",
    })
    assert bad_month.status_code == 400

    bad_irrigation = client.post("/recommend-crop", json={
        "taluka": "Niphad", "sowing_month": 11, "irrigation": "maybe",
    })
    assert bad_irrigation.status_code == 400

    bad_ph = client.post("/recommend-crop", json={
        "taluka": "Niphad", "sowing_month": 11, "irrigation": "yes",
        "soil": {"ph": 20},
    })
    assert bad_ph.status_code == 400
