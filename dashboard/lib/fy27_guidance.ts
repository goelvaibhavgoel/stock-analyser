// FY27 revenue guidance from management concalls/commentary (sourced May 2026)
// guidance is a decimal fraction: 0.31 = 31% growth

export type GuidanceEntry = {
  guidance: number;
  remarks: string;
};

export const FY27_GUIDANCE: Record<string, GuidanceEntry> = {
  // ── Existing watchlist stocks ──────────────────────────────────────────────
  GENUSPOWER: { guidance: 0.31,  remarks: "Company aims to achieve revenue of INR 6,000–6,500 Cr in FY27." },
  EPACKPEB:   { guidance: 0.27,  remarks: "Company aims to achieve revenue of INR 1,925–1,950 Cr (26–28% growth) in FY27." },
  ZAGGLE:     { guidance: 0.40,  remarks: "Targeting standalone revenue growth of 25–30% and consolidated revenue growth of ~40% in FY27." },
  TARIL:      { guidance: 0.29,  remarks: "Company is targeting revenue of INR 3,250 Cr (29% growth) for FY27." },
  EIEL:       { guidance: 0.45,  remarks: "Company has a revenue visibility of INR 2,000 Cr in FY27." },
  SOLEX:      { guidance: 1.04,  remarks: "Management expects FY27 revenue at INR 3,300 Cr." },
  APOLLO:     { guidance: 0.475, remarks: "Management expects revenue to grow at a CAGR of 45–50% over the next 2 years." },

  // ── Banking / NBFC ─────────────────────────────────────────────────────────
  SGFIN:      { guidance: 0.52,  remarks: "Targeting INR 6,000 Cr AUM by FY27 (52% growth); long-term AUM CAGR guidance of 25–30%, PAT CAGR 30–35%." },
  APTUS:      { guidance: 0.23,  remarks: "Targets 22–24% sustainable AUM growth going forward." },
  HOMEFIRST:  { guidance: 0.25,  remarks: "Expects 25% YoY AUM growth in FY27." },
  UGROCAP:    { guidance: 0.225, remarks: "Continues to target AUM growth of 20–25%." },

  // ── IT / Fintech ───────────────────────────────────────────────────────────
  ROBU:       { guidance: 0.50,  remarks: "Confident in sustaining historic 50% CAGR growth with PAT range of 8–10% over the next 2–3 years." },
  INFOLLION:  { guidance: 0.45,  remarks: "Has maintained 40–50% growth historically; aims to continue this momentum." },
  PRIZOR:     { guidance: 0.325, remarks: "Expects sustained revenue growth of 30–35% with long-term potential of INR 1,000 Cr at full utilization." },

  // ── Energy ─────────────────────────────────────────────────────────────────
  MAXVOLT:    { guidance: 0.60,  remarks: "Refrained from providing specific FY27 guidance; indicative growth of 50–70%." },
  ATLANTAELE: { guidance: 0.40,  remarks: "Maintained guidance of ~40% CAGR growth over the next 3 years." },
  SMARTEN:    { guidance: 0.25,  remarks: "Guided for a minimum of 20–30% growth in FY27." },
  SAHAJSOLAR: { guidance: 0.375, remarks: "Targeting 35–40%+ CAGR over the next 3 years with EBITDA margin of 12%+." },
  KPIGREEN:   { guidance: 0.55,  remarks: "Management mentioned 50–60% revenue CAGR by 2030." },
  SHERA:      { guidance: 0.35,  remarks: "Projects 30–40% revenue growth for FY27." },

  // ── Infra ──────────────────────────────────────────────────────────────────
  VMARCIND:   { guidance: 0.40,  remarks: "Aims to achieve 40%+ revenue growth with 11–12% EBITDA margins in FY27." },
  VILAS:      { guidance: 0.45,  remarks: "Expects 45–50% CRGO volume growth and 40–50% topline growth in FY27; targeting INR 1,000 Cr topline." },
  HIRECT:     { guidance: 0.30,  remarks: "Expects to exceed 30% growth for at least the next 3 years." },
  OSWALPUMPS: { guidance: 0.325, remarks: "Expects 30–35% revenue growth over the medium term." },
  APEXECO:    { guidance: 0.35,  remarks: "Management guidance of 30–40% annual revenue growth in the near term." },
  SADHAV:     { guidance: 0.27,  remarks: "Aims to achieve revenue (ex. Shipbuilding JV) of INR 120–130 Cr in FY27 and INR 180 Cr by FY28." },
  GANESHIN:   { guidance: 0.225, remarks: "Aspirational goal of INR 1,000 Cr revenue and INR 90 Cr PAT by FY27; long-term growth target of 20–25%." },
  AVPINFRA:   { guidance: 0.64,  remarks: "Management expects FY27 standalone revenue of INR 700–750 Cr." },

  // ── Metals ─────────────────────────────────────────────────────────────────
  JAINREC:    { guidance: 0.45,  remarks: "Reiterated 40–50% YoY growth guidance; indicated FY27 will be very promising." },

  // ── Healthcare ─────────────────────────────────────────────────────────────
  FABCLEAN:   { guidance: 0.35,  remarks: "Expects 30–40% YoY revenue growth over the next 2 years." },

  // ── Chemicals ──────────────────────────────────────────────────────────────
  ACUTAAS:    { guidance: 0.25,  remarks: "Company guided for 25% revenue growth in FY27." },

  // ── Defence / Aerospace ────────────────────────────────────────────────────
  AVALON:     { guidance: 0.255, remarks: "Management has guided for FY27 revenue growth of 24–27%." },
  AIMTRON:    { guidance: 0.45,  remarks: "Targeting 40–50% revenue CAGR over the next 3–5 years." },
  ZENTEC:     { guidance: 0.60,  remarks: "Revised revenue guidance for FY26–FY28 to INR 4,000 Cr (60% CAGR over 3 years)." },
  GRSE:       { guidance: 0.225, remarks: "Aims to maintain Revenue CAGR of 20–25% over a 5-year period." },

  // ── Auto ───────────────────────────────────────────────────────────────────
  SMLMAH:     { guidance: 0.39,  remarks: "Targeting revenue of INR 15,000 Cr by FY31 (39% CAGR from FY26 base)." },

  // ── FMCG / Consumer ────────────────────────────────────────────────────────
  PNGJL:      { guidance: 0.25,  remarks: "Targets FY27 revenue of INR 13,500 Cr (+25% YoY) with 7.5% EBITDA margin." },
  SHANTIGOLD: { guidance: 0.65,  remarks: "Has guided 60–70% revenue growth for FY27." },
  SATKARTAR:  { guidance: 0.49,  remarks: "Revenue target of INR 300 Cr for FY27 (49% growth, ex. hospital); aspiration of INR 500+ Cr for FY28." },
  SAFEENTP:   { guidance: 0.275, remarks: "Guided for 25–30% annual growth on a long-term basis." },
};
