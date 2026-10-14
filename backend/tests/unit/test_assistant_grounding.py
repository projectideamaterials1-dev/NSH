"""Grounding check for the assistant's answers: numbers must come from the tool data - and from the right row."""
from satellite_api.assistant import grounding

CONJUNCTIONS = {
    "pc_maneuver_threshold": 1e-4,
    "conjunctions": [
        {"cdm_id": "CDM-00018", "satellite_id": "IRS-P6 (RESOURCESAT-1)", "object_id": "FENGYUN 1C DEB #31287",
         "tca": "2026-10-10T23:44:09.258Z", "miss_distance_km": 0.97963, "pc": 2.4402e-21, "minutes_to_tca": 26.3},
        {"cdm_id": "CDM-00022", "satellite_id": "IRS-P5 (CARTOSAT-1)", "object_id": "COSMOS 2251 DEB #1",
         "tca": "2026-10-11T00:49:20.014Z", "miss_distance_km": 3.81512, "pc": 1.39e-278, "minutes_to_tca": 91.5},
    ],
}

# The answer qwen3:8b actually gave in the first live test: right conjunction, right pc and miss
# distance, but the TCA (date and time) copied from CDM-00022.
STEP1_ANSWER = """The most dangerous open conjunction currently is **CDM-00018** (IRS-P6 (RESOURCESAT-1) approaching FENGYUN 1C DEB #31287). Here's why:

- **Collision Probability (pc):** 2.44×10⁻²¹ (highest among listed conjunctions, though still extremely low).
- **Miss Distance:** 0.979 km (closest approach in the dataset, increasing potential risk).
- **Time of Closest Approach:** 2026-10-11T00:49:20.014Z.

While the actual probability remains astronomically low, this conjunction has the **smallest miss distance**."""


def test_value_copied_from_another_row_is_flagged():
    report = grounding.check(STEP1_ANSWER, [CONJUNCTIONS])
    flagged = {i["claim"]: i for i in report["issues"]}
    assert set(flagged) == {"2026-10-11", "00:49:20"}
    assert all(i["problem"] == "belongs_to_other_object" for i in flagged.values())
    assert flagged["00:49:20"]["belongs_to"] == ["CDM-00022", "COSMOS 2251 DEB #1", "IRS-P5 (CARTOSAT-1)"]
    assert flagged["00:49:20"]["scope"] == ["CDM-00018", "FENGYUN 1C DEB #31287", "IRS-P6 (RESOURCESAT-1)"]
    assert report["citations"]["CDM-00018"]["miss_distance_km"] == 0.97963


def test_correct_answer_passes_with_rounding_units_and_notation():
    answer = ("CDM-00018: miss 0.98 km (980 m), pc 2.4e-21, TCA 23:44:09 UTC on 2026-10-10, in about 26.3 minutes.\n"
              "That is far below the threshold of 1e-4.")
    report = grounding.check(answer, [CONJUNCTIONS])
    assert report["issues"] == []
    assert report["checked"] == 7


def test_invented_number_is_reported_as_not_in_tool_data():
    report = grounding.check("CDM-00018 passes at 0.412 km.", [CONJUNCTIONS])
    assert [(i["claim"], i["problem"]) for i in report["issues"]] == [("0.412", "not_in_tool_data")]


def test_nested_record_values_count_for_the_enclosing_record():
    decision = {"decisions": [{"decision_id": "DEC-00011", "satellite_id": "RISAT-1", "rationale": "drift",
                               "burns": [{"burn_id": "AUTO-RISAT-1-0", "delta_v_mps": 0.5299}], "fuel_kg": 0.1981}]}
    report = grounding.check("DEC-00011 planned a 0.5299 m/s burn using 0.1981 kg.", [decision])
    assert report["issues"] == []


def test_numbers_inside_free_text_fields_are_sources():
    # Live run: "Drift of 8.62 km ... 1.06 m/s total" quoted from the decision's rationale was flagged.
    decision = {"decisions": [{"decision_id": "DEC-00011", "satellite_id": "RISAT-1",
                               "rationale": "Drift 8.62 km from its slot; two-burn correction of 1.06 m/s total."}]}
    report = grounding.check("RISAT-1 drifted 8.62 km, so it planned 1.06 m/s in total.", [decision])
    assert report["issues"] == []


def test_ids_small_integers_and_question_numbers_are_not_claims():
    report = grounding.check("Checked 3 conjunctions for RISAT-1 within 5000 km as you asked.", [CONJUNCTIONS],
                             question="anything within 5000 km?")
    assert report["issues"] == []


PROPOSAL = {"proposal_id": "PRP-00001", "satellite_id": "SAT-E", "fuel_kg": 0.7483, "burns": [
    {"burn_id": "AUTO-SAT-E-RADIAL_SHUNT-1767225625-0", "burnTime": "2026-01-01T00:00:25.000Z", "dv_mps": 2.0027},
    {"burn_id": "AUTO-SAT-E-RECOVERY-1767231364-1", "burnTime": "2026-01-01T01:36:04.476Z", "dv_mps": 2.0027}]}


def test_a_bullet_after_a_nested_list_belongs_to_the_parent_item():
    # qwen3:8b in the model eval: "Fuel Used" is a sibling of "Burns", not part of Burn 2.
    answer = ("Proposal PRP-00001 for SAT-E:\n"
              "- **Burns**:\n"
              "  - Burn 1: `AUTO-SAT-E-RADIAL_SHUNT-1767225625-0` at 00:00:25 with 2.0027 m/s\n"
              "  - Burn 2: `AUTO-SAT-E-RECOVERY-1767231364-1` at 01:36:04 with 2.0027 m/s\n"
              "- **Fuel Used**: **0.7483 kg**")
    assert grounding.check(answer, [PROPOSAL])["issues"] == []
    # A value really copied from a sibling burn is still caught.
    wrong = answer.replace("at 00:00:25", "at 01:36:04", 1)
    [issue] = grounding.check(wrong, [PROPOSAL])["issues"]
    assert issue["claim"] == "01:36:04" and "AUTO-SAT-E-RECOVERY-1767231364-1" in issue["belongs_to"]
    assert issue["scope"] == ["AUTO-SAT-E-RADIAL_SHUNT-1767225625-0"]


def test_a_nested_object_brings_its_parent_records_own_fields():
    # qwen3:8b in the model eval: the line names only the debris, whose record is nested in the
    # decision; the decision's pc and fuel are fair to quote there.
    decision = {"decision_id": "DEC-00002", "satellite_id": "SAT-E", "fuel_kg": 0.7483,
                "rationale": ["1 threat(s); worst DEB-2002 with 30 m miss, Pc 5.7e-03"],
                "threats": [{"object_id": "DEB-2002", "miss_km": 0.03}],
                "burns": PROPOSAL["burns"]}
    answer = "The autopilot avoided a threat for SAT-E.\n- Threat: DEB-2002, Pc 5.7e-03, using 0.7483 kg of fuel."
    assert grounding.check(answer, [{"decisions": [decision]}])["issues"] == []
    # Siblings are still separate: burn 1 cannot borrow burn 2's time through the shared parent.
    wrong = "- Burn `AUTO-SAT-E-RADIAL_SHUNT-1767225625-0` fires at 01:36:04"
    [issue] = grounding.check(wrong, [{"decisions": [decision]}])["issues"]
    assert issue["claim"] == "01:36:04"


def test_bullets_under_a_nested_object_may_quote_the_enclosing_record():
    # A proposal's threat row (DEB-2002) and its burns are sibling sub-records. qwen3:8b wrote
    # "Threat: DEB-2002" and then listed the burns underneath; the burn times are the proposal's.
    proposals = {"proposals": [{"proposal_id": "PRP-00001", "satellite_id": "SAT-E", "cdm_ids": ["CDM-00002"],
                                "threats": [{"object_id": "DEB-2002", "miss_distance_km": 0.0291}],
                                "burns": [{"burn_id": "AUTO-SAT-E-1", "burn_time": "2026-01-01T00:00:25.000Z",
                                           "dv_mps": 2.0027}]}]}
    answer = "Threat: DEB-2002, miss 0.0291 km\n- Burn 1 at 00:00:25, 2.0027 m/s"
    assert grounding.check(answer, [proposals])["issues"] == []
    # Naming the object explicitly still keeps the stricter scope.
    assert grounding.check("DEB-2002 burn at 00:00:25", [proposals])["issues"]


def test_action_requests_and_questions_are_told_apart():
    from satellite_api.assistant.agent import wants_action
    for q in ("Schedule the cheapest avoidance burn for CDM-00001.", "Turn off the autopilot.",
              "Set up a radial burn of -0.1 m/s on SAT-C.", "Approve proposal PRP-00001.", "yes, do it",
              "Can you run a screening?", "Reject PRP-1, it uses too much fuel."):
        assert wants_action(q), q
    for q in ("What would happen if I disabled the autopilot?", "Should I approve PRP-1? Don't do anything yet.",
              "Do we need to maneuver for CDM-00002?", "Recommend what to do about CDM-00003.",
              "Is anything waiting for my approval?", "Why did the autopilot maneuver SAT-D?"):
        assert not wants_action(q), q
