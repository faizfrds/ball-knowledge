#!/usr/bin/env python3
"""Generate a SYNTHETIC constituent database with the shape a school's actually has.

THIS IS NOT REAL DATA. Every person, gift, employer and note in the output is
generated. It exists so the GiveCampus adapter can be built and demonstrated before
the real file arrives; `load_constituents.py` reads a real CSV into the same tables,
and nothing downstream knows the difference.

The design point is the `notes` column. Class year, city and lifetime giving are
structured fields that SQL has always been able to filter. What no query language can
reach is the gift officer's free text -- "mentioned wanting to fund scholarships when
her kids finish college", "frustrated about the stadium project" -- and that is
exactly the material this system reads. The generator therefore spends its effort on
notes that carry real signal, correlated with the structured fields rather than
sprinkled at random.
"""

from __future__ import annotations

import argparse
import random
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

FIRST = """James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William
Barbara Richard Susan Joseph Jessica Thomas Sarah Charles Karen Christopher Nancy Daniel
Lisa Matthew Betty Anthony Margaret Mark Sandra Donald Ashley Steven Kimberly Paul Emily
Andrew Donna Joshua Michelle Kenneth Carol Kevin Amanda Brian Dorothy George Melissa
Timothy Deborah Ronald Stephanie Jason Rebecca Edward Sharon Jeffrey Laura Ryan Cynthia
Jacob Kathleen Gary Amy Nicholas Angela Eric Shirley Jonathan Anna Stephen Ruth Larry
Brenda Justin Pamela Scott Nicole Brandon Katherine Benjamin Samantha Samuel Christine
Gregory Catherine Alexander Virginia Patrick Rachel Frank Janet Raymond Emma Jack Maria
Dennis Heather Jerry Diane Tyler Julie Aaron Joyce Jose Victoria Adam Kelly Nathan
Christina Henry Joan Zachary Evelyn Douglas Lauren Peter Judith Kyle Olivia Noah Frances
Ethan Martha Jeremy Cheryl Walter Megan Christian Andrea Keith Hannah Roger Jacqueline
Terry Ann Austin Gloria Sean Jean Gerald Alice Carl Kathryn Harold Louise Dylan Sara
Arthur Grace Lawrence Judy Jordan Theresa Jesse Beverly Bryan Denise Billy Marilyn Bruce
Amber Gabriel Danielle Joe Rose Logan Brittany Alan Diana Juan Abigail Albert Natalie
Willie Jane Elijah Lori Wayne Alexis Randy Tiffany Vincent Kayla Mason Charlotte Roy
Priya Wei Ahmed Sofia Yuki Ravi Ingrid Omar Chen Nadia Luis Fatima Dmitri Aisha Kofi
Mei Rahul Elena Hassan Anika Tomas Leila Jin Camila Arjun Zara Nikolai Amara""".split()

LAST = """Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez
Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez
Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King
Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell
Mitchell Carter Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins
Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson
Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James
Bennett Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross
Foster Jimenez Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson
Barnes Gonzales Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton
Graham Reynolds Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis
Tran Medina Aguilar Stevens Murray Ford Castro Marshall Owens Harrison Fernandez
Okafor Schmidt Novak Larsen Rossi Dubois Kowalski Ivanov Tanaka Singh Ahmed Silva
Andersson Hoffmann Moreau Lindqvist Nakamura Petrov Costa Weber Laurent Berg""".split()

CITIES = [("Boston","MA"),("New York","NY"),("San Francisco","CA"),("Chicago","IL"),
          ("Washington","DC"),("Seattle","WA"),("Los Angeles","CA"),("Austin","TX"),
          ("Denver","CO"),("Atlanta","GA"),("Philadelphia","PA"),("Portland","OR"),
          ("Cambridge","MA"),("Brooklyn","NY"),("Houston","TX"),("Miami","FL"),
          ("Minneapolis","MN"),("Nashville","TN"),("San Diego","CA"),("Pittsburgh","PA")]

SCHOOLS = ["College of Arts & Sciences","School of Engineering","School of Business",
           "School of Education","School of Nursing","School of Law"]
CLUBS = ["Alumni Choir","Crew","Debate Society","Model UN","Student Government",
         "Marching Band","Rugby Club","Chess Club","Theater Company","Robotics Team",
         "Volunteer Corps","Investment Club","Radio Station","Literary Review"]
ATHLETICS = ["Varsity Soccer","Varsity Basketball","Varsity Crew","Varsity Track",
             "Varsity Swimming","Varsity Lacrosse","Varsity Tennis"]
VOLUNTEER = ["Class Agent","Reunion Committee","Regional Chapter Lead","Career Mentor",
             "Admissions Interviewer","Advisory Board","Giving Day Ambassador"]
INDUSTRIES = ["Technology","Finance","Healthcare","Education","Law","Consulting",
              "Nonprofit","Manufacturing","Real Estate","Media","Government","Energy"]
SENIORITY = ["Analyst","Associate","Manager","Director","Vice President","Partner",
             "Principal","Founder","Chief Executive Officer","Chief Financial Officer",
             "Professor","Retired"]
EMPLOYERS = ["Northgate Capital","Bluepeak Health","Ardent Systems","Kestrel Analytics",
             "Fairmont Legal","Silverline Consulting","Harborview Partners","Ridgeway Media",
             "Cobalt Energy","Union Square Ventures","Meridian Health","Lakeshore Schools",
             "Trellis Software","Anchor Foundation","Crestline Realty","Vantage Robotics"]
DESIGNATIONS = ["Annual Fund","Scholarship Fund","Athletics","Library","Financial Aid",
                "Faculty Chair","Capital Campaign","Student Life","Unrestricted"]


def make_note(rng, c) -> str:
    """Free text of the kind a gift officer actually leaves, correlated with the row."""
    bits = []
    gap = c["current_year"] - (c["last_gift_year"] or c["current_year"])
    if c["lifetime_giving"] > 25_000 and gap >= 4:
        bits.append(rng.choice([
            "Consistent major supporter historically but has not been contacted since "
            "the last campaign closed; no assigned officer for three cycles.",
            "Gave generously for a decade then went quiet after their class agent "
            "stepped down. No known issue, simply nobody has called.",
            "Long-time leadership donor. File shows no substantive outreach in several "
            "years despite continued event attendance."]))
    if c["seniority"] in ("Partner", "Founder", "Chief Executive Officer",
                          "Chief Financial Officer", "Vice President"):
        bits.append(rng.choice([
            f"Recently promoted to {c['job_title']} at {c['employer']}; LinkedIn update "
            f"noted by the research team this quarter.",
            f"Took on a significantly larger role at {c['employer']} last year. Prior "
            f"ask amount is well below current apparent capacity.",
            f"Now {c['job_title']}. Still being solicited at the level set when they "
            f"were several years more junior."]))
    if c["volunteer_roles"]:
        bits.append(rng.choice([
            f"Reliable volunteer — served as {c['volunteer_roles'][0]} and answers email "
            f"the same day.",
            f"Deeply engaged as {c['volunteer_roles'][0]}; often recruits classmates "
            f"before staff can reach them."]))
    if c["years_to_reunion"] == 0:
        bits.append("Reunion year. Classmates already organising a class gift.")
    if c["is_recurring"]:
        bits.append(f"Monthly recurring donor at ${c['recurring_monthly']:.0f}; has never "
                    f"been asked to increase the amount.")
    if c["student_worker"]:
        bits.append("Worked in the dining hall as a student and has mentioned that "
                    "financial aid was the reason they could attend.")
    if rng.random() < 0.18:
        bits.append(rng.choice([
            "Asked to be contacted by phone rather than email.",
            "Expressed frustration with the stadium project and prefers their gift "
            "restricted to financial aid.",
            "Spouse is also an alum of the class two years behind.",
            "Travels for work most of the year; best reached in August.",
            "Has asked about donor-advised fund logistics.",
            "Declined the last two event invitations, cites distance.",
            "Mentioned wanting to fund scholarships once their children finish college.",
            "Recently relocated and has not updated their mailing address.",
        ]))
    if not bits:
        bits.append(rng.choice([
            "No recent contact recorded.",
            "Attends regional events occasionally; no giving conversation on file.",
            "Opens email but has not clicked through in over a year.",
        ]))
    rng.shuffle(bits)
    return " ".join(bits)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Generate a synthetic constituent database.")
    ap.add_argument("-n", "--count", type=int, default=25_000)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out-dir", default="data/givecampus")
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    today = date(2026, 9, 20)
    cy = today.year
    rows = []

    for i in range(args.count):
        class_year = rng.choices(range(1958, 2026),
                                 weights=[1 + (y - 1958) ** 1.4 for y in range(1958, 2026)])[0]
        age_out = cy - class_year
        first, last = rng.choice(FIRST), rng.choice(LAST)
        city, state = rng.choice(CITIES)

        # Giving: older alumni have had more years to give; most give nothing.
        gives = rng.random() < min(0.12 + age_out * 0.012, 0.62)
        if gives:
            n_gifts = max(1, int(rng.lognormvariate(0.9, 0.9)))
            avg = rng.lognormvariate(4.6, 1.5)
            # Real advancement files are far more concentrated than a plain lognormal:
            # roughly a tenth of donors carry most of the dollars. Without an explicit
            # major-gift tier the dataset has almost no one worth a visit, which is
            # precisely the population this tool exists to find.
            tier = rng.random()
            if tier > 0.985:
                avg *= rng.uniform(40, 220)      # principal gift
            elif tier > 0.94:
                avg *= rng.uniform(8, 40)        # major gift
            elif tier > 0.82:
                avg *= rng.uniform(2.5, 8)       # leadership annual
            lifetime = round(n_gifts * avg, 2)
            first_gift = rng.randint(class_year, cy)
            last_gift = min(cy, first_gift + rng.randint(0, max(age_out, 1)))
            largest = round(avg * rng.uniform(1.0, 3.5), 2)
            last_amount = round(avg * rng.uniform(0.4, 1.6), 2)
        else:
            n_gifts, lifetime, first_gift, last_gift = 0, 0.0, None, None
            largest, last_amount = 0.0, 0.0

        recurring = gives and rng.random() < 0.14
        seniority = rng.choices(SENIORITY,
                                weights=[14, 16, 18, 14, 9, 5, 4, 4, 3, 2, 5, 6])[0] \
            if age_out > 3 else rng.choice(["Analyst", "Associate"])
        years_to_reunion = (5 - (age_out % 5)) % 5

        c = {
            "constituent_id": f"C{i:06d}",
            "first_name": first, "last_name": last,
            "full_name": f"{first} {last}",
            "class_year": class_year,
            "years_since_graduation": age_out,
            "school": rng.choice(SCHOOLS),
            "city": city, "state": state,
            "lifetime_giving": lifetime,
            "gift_count": n_gifts,
            "first_gift_year": first_gift,
            "last_gift_year": last_gift,
            "years_since_last_gift": (cy - last_gift) if last_gift else None,
            "largest_gift": largest,
            "last_gift_amount": last_amount,
            "is_recurring": recurring,
            "recurring_monthly": round(rng.uniform(10, 250), 2) if recurring else 0.0,
            "events_attended": max(0, int(rng.gauss(1.6, 2.0))),
            "volunteer_roles": rng.sample(VOLUNTEER, rng.choices([0,1,2],[72,22,6])[0]),
            "clubs": rng.sample(CLUBS, rng.choices([0,1,2],[48,38,14])[0]),
            "athletics": rng.choice(ATHLETICS) if rng.random() < 0.17 else None,
            "employer": rng.choice(EMPLOYERS),
            "job_title": None, "industry": rng.choice(INDUSTRIES),
            "seniority": seniority,
            "email_opens_12mo": max(0, int(rng.gauss(7, 7))),
            "email_clicks_12mo": max(0, int(rng.gauss(1.4, 2.2))),
            "years_since_contact": rng.choices([0,1,2,3,4,5,6],[26,20,16,12,10,9,7])[0],
            "assigned_officer": rng.choice([None,"A. Reyes","M. Okafor","T. Lindqvist",
                                            "J. Park","D. Whitfield"]),
            "preferred_designation": rng.choice(DESIGNATIONS),
            "years_to_reunion": years_to_reunion,
            "student_worker": rng.random() < 0.21,
            "current_year": cy,
        }
        c["job_title"] = f"{seniority}, {c['industry']}"
        c["notes"] = make_note(rng, c)
        c.pop("current_year")
        rows.append(c)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), out / "constituents.parquet",
                   compression="zstd")

    db = out / "givecampus.duckdb"
    db.unlink(missing_ok=True)
    con = duckdb.connect(str(db))
    con.execute(f"CREATE VIEW constituents AS SELECT * FROM "
                f"read_parquet('{out/'constituents.parquet'}')")
    n, giving, total = con.execute(
        "SELECT count(*), count(*) FILTER (WHERE gift_count > 0), sum(lifetime_giving) "
        "FROM constituents").fetchone()
    lapsed = con.execute("SELECT count(*) FROM constituents WHERE lifetime_giving >= 25000 "
                         "AND years_since_last_gift >= 4").fetchone()[0]
    con.close()
    print(f"SYNTHETIC DATA — not real constituents")
    print(f"  {n:,} constituents, {giving:,} donors, ${total:,.0f} lifetime giving")
    print(f"  {lapsed:,} lapsed major donors (>=$25k, no gift in 4+ years)")
    print(f"  wrote {out/'constituents.parquet'} and {db}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
