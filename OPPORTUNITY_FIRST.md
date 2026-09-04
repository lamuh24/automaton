# Opportunity-first operating mode

Lamuh Automaton starts by researching legitimate, low-capital ways to earn money from useful work. It does not start with trading. The $20/day target is a qualification rule, not a promise of income.

The first stage may research and rank opportunities such as freelance services, local-business help, digital products, software utilities, lead research, and other legal work. It must reject opportunities involving deposits, advance fees, gambling, impersonation, deception, spam, credential sharing, or guaranteed-return claims.

The automaton may prepare research, drafts, prototypes, and recommendations autonomously. It must obtain creator approval before contacting people, creating accounts, publishing listings, accepting contractual terms, spending money, or representing that the creator agreed to anything.

Initialize and inspect the local ledger:

```bat
opportunity-first.cmd initialize
opportunity-first.cmd add "Example service" 25 "https://example.com" "Why it fits and what must be verified"
opportunity-first.cmd list
opportunity-first.cmd status
```

Only the creator should record money that was actually received and independently verified:

```bat
opportunity-first.cmd record-earning 2026-09-03 25.00 "Website audit" "Receipt or invoice reference"
```

Crypto research and paper simulation remain locked until every one of the most recent seven local calendar days contains at least $20 in creator-verified, non-trading earnings. Even after that earnings gate passes, the creator must explicitly launch the process with:

```bat
set AUTOMATON_CRYPTO_APPROVAL=LAMUH_APPROVES_CRYPTO_RESEARCH
```

That phrase unlocks research and paper simulation only. This repository contains no live exchange integration and cannot place real-money orders.

