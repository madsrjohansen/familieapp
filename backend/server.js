import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY mangler. Legg den i miljøvariabler før du starter serveren.");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CATEGORY_VALUES = [
  "Frukt og grønt",
  "Meieri",
  "Brød og pålegg",
  "Proteiner",
  "Tørrvarer",
  "Frys",
  "Drikke",
  "Snacks",
  "Kosmetikk",
  "Annet",
];

function normalizeParsedItems(payload) {
  if (!payload || !Array.isArray(payload.items)) return [];

  return payload.items
    .map((item) => {
      const name = String(item?.name || "").trim().toLowerCase();
      const quantity = Number(item?.quantity) > 0 ? Number(item.quantity) : 1;
      const category = CATEGORY_VALUES.includes(item?.category)
        ? item.category
        : "Annet";

      if (!name) return null;

      return { name, quantity, category };
    })
    .filter(Boolean);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/parse", async (req, res) => {
  try {
    const input = String(req.body?.input || "").trim();

    if (!input) {
      return res.status(400).json({ error: "Mangler input" });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
instructions:
  "Du er en svært presis norsk handleassistent for en familieapp. " +

  "OPPGAVE: Tolk brukerens tekst til konkrete handlevarer. " +

  "REGLER: " +
  "1. Hvis teksten IKKE starter med 'ting til', skal du KUN returnere det brukeren faktisk skrev. Ikke legg til noe ekstra. " +
  "2. Hvis teksten starter med 'ting til', kan du foreslå relevante ingredienser til retten. " +
  "3. Forstå mengder som 'x 3', '* 3', '3 stk', og lignende. " +
  "4. Normaliser navn forsiktig (f.eks 'helmel' → 'helmelk'). " +

  "KATEGORIER (VELG ÉN PER VARE): " +
  "Frukt og grønt, Meieri, Brød og pålegg, Proteiner, Tørrvarer, Frys, Drikke, Snacks, Kosmetikk, Annet. " +

  "VIKTIG KATEGORISERING: " +
  "- kjøttkaker, kjøttdeig, kylling, fisk → Proteiner " +
  "- melk, ost, yoghurt → Meieri " +
  "- brød, knekkebrød → Brød og pålegg " +
  "- sjampo, tannkrem → Kosmetikk " +

  "SVARFORMAT (KUN JSON, INGEN TEKST): " +
  "{\"items\":[{\"name\":\"\",\"quantity\":1,\"category\":\"\"}]}",
      input,
    });

    const rawText = response.output_text?.trim() || '{"items":[]}';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      console.error("Kunne ikke parse modellsvaret som JSON", parseError, rawText);
      return res.status(502).json({
        error: "Ugyldig JSON fra AI",
        rawText,
      });
    }

    const items = normalizeParsedItems(parsed);

    return res.json({
      items,
      rawText,
      requestId: response._request_id || null,
    });
  } catch (error) {
    console.error("Feil i /api/parse", error);

    return res.status(500).json({
      error: "Kunne ikke tolke handlelisten akkurat nå.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.listen(port, () => {
  console.log(`Matfane API kjører på http://localhost:${port}`);
});
