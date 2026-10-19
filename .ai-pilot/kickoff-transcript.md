## Phase 1 Brief

Status: COMPLETE

**Leadership vision (D01):** Lower cost by replacing the current ATS with a smaller workflow.

**Phase 1 end-to-end workflow (ordered steps):**

1. **Open demand** — Actor: internal recruiter. Input: staffing need and client context. Output: active requisition in ATS (D02).
2. **Attract and source** — Actor: recruiter. Input: requisition. Output: jobs posted and marketed across channels (D03).
3. **Capture applications** — Actor: candidate / recruiter. Input: applications from channels. Output: candidate profile with full parity fields (D04).
4. **Screen and qualify** — Actor: recruiter / system. Input: candidate on req. Output: qualified candidate including tests and automated scoring (D05).
5. **Client submission** — Actor: recruiter in MaxView. Input: qualified candidate from ATS. Output: client submission (D06; not built in replacement ATS Phase 1).
6. **Interview tracking** — Actor: recruiter. Input: interview events. Output: dates and outcomes in recruiter notes only (D07).
7. **Offer and placement** — Actor: recruiter. Input: selected candidate. Output: offer and placement recorded in ATS with full workflow parity (D08).
8. **Onboarding and compliance** — Actor: recruiter / compliance. Input: placed candidate. Output: compliance artifacts and onboarding parity (D09).
9. **Assignment and billing** — Actor: operations / finance. Input: placement. Output: assignment lifecycle and billing parity in ATS (D10).
10. **Client and vendor CRM** — Actor: account team. Input: client and vendor interactions. Output: full CRM parity on reqs and relationships (D11).
11. **Reporting** — Actor: leadership / ops. Input: ATS data. Output: full reporting and analytics parity (D12).
12. **Administration** — Actor: platform admin. Input: users and config. Output: minimum viable admin; most integrations and bulk migration deferred (D13).

**Phase 1 scope by decision id:** D02, D03, D04, D05, D06 (boundary), D07, D08, D09, D10, D11, D12, D13, D14.

**Unresolved items:** None.

## Deferred Roadmap

| Item | Area | Reason | Revisit trigger | Decision id |
|------|------|--------|-----------------|-------------|
| Bulk migration from legacy ATS | L12 | Minimum viable admin for go-live | Cutover date and data scope agreed | D13 |
| Most back-office and third-party integrations | L12 | Deferred to later wave | Phase 1 core workflow stable in production | D13 |
| Interview scheduling integrations | L06 | Notes-only tracking in Phase 1 | Client SLAs or volume require automated scheduling | D07 |
| Automated MaxView sync (if not manual) | L05 / L12 | Submission owned by MaxView; integrations deferred | Submission errors or double-entry pain in pilot | D06, D13 |

## Research Notes

No market research claims. All scope decisions use basis leader.

## Final Decision Ledger

D01 · confirmed · Leadership vision · Lower cost by replacing current ATS with smaller workflow · basis leader  
D02 · confirmed · Phase 1 workflow · Requisitions created by internal recruiters only · L01 · basis leader  
D03 · confirmed · Phase 1 workflow · Full multi-channel sourcing and marketing in Phase 1 · L02 · basis leader  
D04 · confirmed · Phase 1 workflow · All channels capture apps; full candidate profile parity in Phase 1 · L03 · basis leader  
D05 · confirmed · Phase 1 workflow · Full screening parity including tests and automated scoring in Phase 1 · L04 · basis leader  
D06 · confirmed · Phase 1 boundary · Client matching and submission owned by MaxView, not replacement ATS Phase 1 · L05 · basis leader  
D07 · confirmed · Phase 1 workflow · Interview dates and outcomes in recruiter notes only; no scheduling integrations · L06 · basis leader  
D08 · confirmed · Phase 1 workflow · Full offer and placement workflow parity in Phase 1 · L07 · basis leader  
D09 · confirmed · Phase 1 workflow · Full onboarding and compliance parity in Phase 1 · L08 · basis leader  
D10 · confirmed · Phase 1 workflow · Full assignment lifecycle and billing parity in Phase 1 · L09 · basis leader  
D11 · confirmed · Phase 1 workflow · Full client and vendor CRM parity in Phase 1 · L10 · basis leader  
D12 · confirmed · Phase 1 workflow · Full reporting and analytics parity in Phase 1 · L11 · basis leader  
D13 · confirmed · Phase 1 go-live · Minimum viable admin; defer most integrations and bulk migration · L12 · basis leader  
D14 · confirmed · Phase 1 lock · Lock proposed end-to-end Phase 1 workflow as stated · basis leader  

This ledger overrides every earlier ledger in this conversation.
