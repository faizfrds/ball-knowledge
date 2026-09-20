# Ball Knowledge

Hackathon submission copy. Each section below maps to a field on the submission form.

---

## Inspiration

A search bar that costs $9.75 every time someone types into it is not a search bar.

That is what it costs today to have Claude Opus 5 read fourteen thousand donor records
and pick out the twenty people worth calling this week. It works, and it takes about
two and a half minutes. Run it across a fundraising team a hundred times a day and you
have spent roughly a quarter of a million dollars a year on a search box.

The arithmetic behind that number does not improve with a bigger model, because there
are only two ways to point an LLM at a large pile of data and both of them break.

You can put the whole pile in the prompt. We pulled 152,713 research papers published
by MIT from OpenAlex, the free public database of the world's scholarly output, as a
test corpus. That is about 58 million tokens. No model accepts it, and long before you
reach the limit the model is slower, more expensive, and measurably worse at attending
to any single item buried in the middle of it.

Or you can call the LLM once per item. This is the honest version and it is the
expensive one. Every item pays for its own reasoning tokens, so cost scales linearly
with the size of your data, and you pay it again on every single query. Classifying our
corpus one paper at a time through a frontier model runs to hundreds of dollars for a
question you might want to ask twice. Nobody ships a product that way.

So everyone settles. Keyword search, which is fast and cheap but cannot express "and",
"not", or a judgment call. Or an LLM reranking the top 100 results, which only helps if
the right answer was already in the top 100, and the whole reason you are searching is
that you do not know where it is.

What changed is that the missing piece finally exists. TypeSafe released Jev this year,
a new class of model that returns typed answers and calibrated probabilities instead of
generated text. It does not write, it decides, and asking it one yes or no question
about one item costs a fraction of a cent. That makes judgment at scale affordable for
the first time, and it makes a different architecture possible.

Because the job was never one job. Understanding an ambiguous question is one skill.
Applying a fixed criterion to fifty thousand items is a completely different one.
Counting and sorting was never a model's job at all. We built a system that stops
pretending otherwise, and then realised the same insight rewrites storage too: if
judging a corpus produces a reusable answer, throwing that answer away is the waste. A
question asked often enough should stop being a query and become a column.

---

## What it does

Ball Knowledge is a new way to search and store information.

Search is multi stage. You ask in plain English. An LLM compiles your question into a
rubric: SQL filters, retrieval phrasings, must have gates, graded criteria, bonuses,
and next action tags. Filters run as SQL, because dates and amounts are arithmetic and
arithmetic belongs in code. Hybrid keyword and vector retrieval narrows the field. Jev
then judges every surviving candidate against your rubric, not a shortlist and not a
top 100 window. Code ranks the results. An LLM returns exactly once, at the end, to
write a one line reason under each winner.

The LLM never reads your data. It sees your question at the start and twenty titles at
the end. That is the whole trick, and it is why this gets cheaper per item as your data
grows instead of impossible.

Storage is the second half, and it is the part we think is new. Run a question across
the entire corpus once and it becomes a permanent field. We asked "does this paper use
large language models?" of all 118,354 MIT abstracts for $3.21 and created a column
that OpenAlex does not have, so you can now chart AI adoption across MIT by field and
by year. Every future query filters that column in SQL, free and instant. Queries
become columns. The database gets smarter every time someone uses it.

We built three use cases to prove the method generalises: donor intelligence for
GiveCampus, research discovery and file driven matching for Dropbox, and clinical trial
matching for Regeneron. Same engine, same code, three completely different shapes of
data. Pointing it at a new dataset takes three things: a schema description, a row
formatter, and a column list. Indexing 25,000 records takes 42 seconds and costs 2
cents.

---

## How we built it

One pipeline, three use cases, no forked code.

A query is routed by complexity. Deep questions go to an LLM that compiles the rubric.
Hard constraints such as dates, amounts and counts are evaluated in SQL. BM25, the
standard keyword ranking algorithm behind most search bars, runs alongside vector
search over 117,298 embeddings, and the two rankings are fused. Jev then answers small,
focused yes or no and graded questions about each candidate, reading only the fields a
given question actually names, because extra context costs tokens and lowers accuracy.
Code combines the scores with a deterministic ranking formula. An LLM writes the
explanations.

The stack is DuckDB for structured filters and keyword search, OpenAI
text-embedding-3-small for the vectors, searched by brute force because at this size an
approximate index would only add error, GPT-5.2 and GPT-5.6 Luna for rubric
compilation, Jev for bulk judgment, and FastAPI behind a single page frontend.

Three engineering decisions made it fast enough to demo live.

Wave based early stopping. Candidates are judged 1,500 at a time in retrieval order and
we stop once 150 have cleared the gates, because further waves cannot change the top
20. Cost scales with how hard the question is rather than with the size of the pool.
One query judged 1,500 of 4,000 candidates and cost 2 cents.

Batched judgment at the measured optimum. We swept the accuracy and throughput curve
instead of guessing, and settled on 25 items per request.

Forty way concurrency. Jev permits 1,200 requests per minute and we were using five
percent of it. Judgment time dropped from 78 seconds to 15.

Every query returns a cost receipt showing candidates judged, tokens spent, latency
percentiles and dollars, so anyone can audit the claim on screen rather than taking our
word for it.

---

## Individual contributions

We built the shared engine together: query routing, rubric compilation, retrieval, Jev
evaluation, ranking, caching, explanations and the interface. Then we split the three
use cases, with each person responsible for adapting the shared engine to their
dataset, building the demo workflow, and running the evaluation for that vertical.
Because the engine is shared, an improvement made for one use case landed in all three,
which is how three verticals fit into one hackathon.

---

## Challenges we ran into

Deciding what belongs to which layer. Jev is strong at semantic judgment and weak at
arithmetic, so every number, date and count goes to SQL. We had to write that into the
compiler's instructions explicitly, because early versions asked a judge model to infer
amounts that were already columns sitting in the database.

Batching trades accuracy, and the obvious metric hides it. Packing 25 items into one
request agreed with one at a time judgment 98 percent of the time, which looked free.
Against a proper answer key it was not: a combined accuracy score of 0.723 batched
against 0.966 one at a time, with no overlap between their confidence ranges. That 98
percent was agreement on the easy negatives, because only 1.6 percent of the corpus was
a positive. We now run accuracy critical passes one at a time and batch only where raw
throughput is what matters.

Probabilities that rank well are not necessarily calibrated. Averaging Jev's
probabilities to estimate a corpus wide share gave 5.59 percent where the truth was
1.73 percent, while simply counting the yes answers gave 1.61 percent, which is 32
times more accurate. We caught it with a sanity check anyone can repeat: large language
models did not exist in 2015, so any correct method must return roughly zero for 2015.
Ours returned 2.2 percent, which meant it was measuring its own error rate.

Ranking has to reflect the job, not just the question. On the donor data our first
results were people who had never given a dollar. Engaged, plausible, and useless to a
gift officer with forty hours a week and thousands of names. Giving is extremely
concentrated, with the top ten percent of donors holding about ninety percent of the
dollars, so we made ranking an expected value: how well someone fits the question
multiplied by what acting on them is worth. That single change moved the total dollars
at stake in the top five results of one query from $974 to $7.9 million.

Security, because the rubric compiler is an LLM writing SQL that lands in a live WHERE
clause. Every fragment is validated against a column allowlist read from the actual
table schema, and statement separators, schema changes, set operations and file reading
functions are rejected and reported in the receipt.

---

## Accomplishments that we're proud of

One architecture, three use cases, and the numbers to back it.

**Context reduction of roughly 10,000 times.** Putting all 152,713 papers into a prompt
would be about 58 million tokens per query, which no model accepts. We use about 6,000
tokens per query: 2,000 to write the rubric and 4,000 to explain the results.

**Cost reduction of 42 to 95 times on identical work.** Jev processed 100,683,899
tokens of input for $4.23. Sending the exact same text through gpt-5.2 would cost
$176.20, and through gpt-5.6-sol, $402.74. On one query over 14,052 donor records our
approach costs about $0.16 against about $9.75 for the same job done by Claude Opus 5,
roughly 60 times cheaper. Our entire project, every experiment included, used 131.4
million tokens and cost $8.29.

**Latency reduction of 3.8 to 5.6 times.** Median response time per request, meaning
half of requests were faster than this, was 0.19 seconds for Jev against 0.72 for
gpt-5.2 and 0.96 for gpt-5.6-sol. Items processed per second were 48.4 one at a time
and 309 batched, against 13.1 and 8.6. End to end a user gets an answer in 20 to 25
seconds where the Claude Opus 5 equivalent projects to one to two and a half minutes.
Classifying the whole corpus ran at 464 items per second, finishing 112,779 abstracts
in 243 seconds.

**Accuracy statistically tied with frontier models.** To check that Jev was right and
not merely cheap, we built an answer key. Two strong models that were not competing in
the test, gpt-6-astra and gpt-5.5, independently labelled 300 papers. They agreed on
296, with a Cohen's kappa of 0.964, a standard agreement score where 1.0 means two
labellers never disagreed. Those 296 became the key, and the four they disagreed on
were discarded rather than resolved in anyone's favour. F1 below is a combined accuracy
score between 0 and 1 balancing finding the right answers against avoiding wrong ones.
The range beside it is a 95 percent confidence interval from rerunning the scoring a
thousand times on resampled data, and where two ranges overlap the difference between
those systems is not statistically meaningful.

```
model,              F1,     95% confidence interval,  $ per 1M items
gpt-5.6-sol,        0.993,  0.976 to 1.000,           1618.75
deepseek-v4-flash,  0.980,  0.954 to 1.000,           103.31
gpt-5.2,            0.979,  0.949 to 1.000,           689.21
Jev,                0.966,  0.931 to 0.993,           27.74
mimo-v2.5,          0.680,  0.396 to 0.987,           unpriced
```

Every range overlaps ours except the cheap model at the bottom, which we included
deliberately as a floor to show the task is not trivially easy. The same accuracy as
models costing 25 to 60 times more, running four times faster.

**Retrieval quality that beats every baseline.** We ran 80 real fundraising questions
and counted how many of the right people each system placed in its top 20. NDCG is a
standard search quality score rewarding systems that put the best answers nearest the
top.

```
system,                          right answers in top 20,  NDCG score
Luna + semantic + BM25 + Jev,    44 out of 80,             0.3956
semantic search only,            40 out of 80,             0.3144
semantic + keyword search,       37 out of 80,             0.3207
```

That is ten percent more of the right people than meaning based search alone, and 18.9
percent more than meaning and keyword search combined.

**And a finding that did not exist before we ran it.** Our enrichment column shows large
language model use at MIT rising from 0.0 percent of papers in 2015 through 2018 to 6.2
percent in 2026, which is 595 papers last year. The zero in the early years is the
proof the method works, because those models had not been invented yet.

---

## What we learned

Scaling an AI system is less about reaching for a bigger model than about routing each
part of the problem to the right tool. LLMs are best at turning an ambiguous human
request into explicit criteria. Small judgment models are best at applying those
criteria to many independent items. Ordinary code remains better at filtering,
arithmetic, counting and ranking, and putting arithmetic inside a model is precisely
where accuracy quietly disappears.

Prompt structure matters far more when a model is a component in a system than when it
is a chatbot. Small, focused questions carrying only the fields they actually need are
cheaper, more accurate, and reusable across every item in the corpus. A question
written once can be asked of fifty thousand rows.

We also learned to distrust the convenient metric. The numbers that looked best were
consistently the ones that had not been checked hard enough, and every real finding
came from asking what the result would look like if we were wrong.

---

## What's next

**Storage that builds itself.** Today we materialise a column by choosing the question.
Next are agents that watch query traffic, notice a condition being judged over and over
across many different searches, and run that condition corpus wide automatically, so
popular questions migrate out of the judgment layer and into SQL on their own. Search
makes the database smarter, and the smarter database makes the next search cheaper.
That compounding is the product.

**Caching at the level of each item and question pair.** Every judgment is deterministic
given the item and the question, so editing a single rubric criterion should re-run only
that one question rather than the entire search. Rubric editing becomes instant and
interactive.

**Fitted ranking.** The expected value weights on the donor data are reasoned rather
than trained, because no outcome history was available to fit them. Real contact and
response data turns them into a propensity model, and dollars at stake becomes a
genuine forecast rather than a capacity estimate.

**Human labelled ground truth.** Our answer key is two frontier models agreeing at a
kappa of 0.964, which is strong, but a blind spot shared by both would be inherited by
everything measured against it.

**Broader question sets.** The architecture is built for questions carrying several
simultaneous conditions, where a hundred document shortlist simply runs out of
candidates that satisfy all of them. That is where the gap over conventional search
should be widest, and it is where we want the next benchmark to live.
