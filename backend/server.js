import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY mangler. Legg den i miljøvariabler før du starter serveren.");
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.warn("SUPABASE_URL eller SUPABASE_KEY mangler. Legg dem inn i miljøvariabler.");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

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

const DEFAULT_USERS = ["Mamma", "Pappa", "Barn 1", "Barn 2"];

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

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function displayName(value) {
  const safe = String(value || "").trim();
  if (!safe) return "";
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

async function ensureDefaultFamilyMembers() {
  const { data, error } = await supabase
    .from("family_members")
    .select("*")
    .order("id", { ascending: true });

  if (error) {
    throw error;
  }

  if (Array.isArray(data) && data.length > 0) {
    return data;
  }

  const rowsToInsert = DEFAULT_USERS.map((name) => ({ name }));

  const { data: inserted, error: insertError } = await supabase
    .from("family_members")
    .insert(rowsToInsert)
    .select();

  if (insertError) {
    throw insertError;
  }

  return inserted || [];
}

app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("family_members").select("id").limit(1);

    res.json({
      ok: true,
      database: !error,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: false,
      error: error?.message || "Ukjent feil",
    });
  }
});

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const familyMembers = await ensureDefaultFamilyMembers();

    const [
      { data: items, error: itemsError },
      { data: history, error: historyError },
      { data: suggestionMemory, error: suggestionError },
    ] = await Promise.all([
      supabase
        .from("shopping_items")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: true }),
      supabase
        .from("purchase_history")
        .select("*")
        .order("purchased_at", { ascending: false }),
      supabase
        .from("suggestion_memory")
        .select("*")
        .order("purchased_at", { ascending: false }),
    ]);

    if (itemsError) throw itemsError;
    if (historyError) throw historyError;
    if (suggestionError) throw suggestionError;

    return res.json({
      users: (familyMembers || []).map((member) => member.name),
      items: items || [],
      history: history || [],
      suggestionMemory: suggestionMemory || [],
    });
  } catch (error) {
    console.error("Feil i /api/bootstrap", error);

    return res.status(500).json({
      error: "Kunne ikke hente data fra databasen.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.post("/api/family-members", async (req, res) => {
  try {
    const rawUsers = Array.isArray(req.body?.users) ? req.body.users : [];
    const users = rawUsers
      .map((name) => String(name || "").trim())
      .filter(Boolean)
      .slice(0, 6);

    if (users.length === 0) {
      return res.status(400).json({ error: "Du må sende minst ett navn." });
    }

    const { error: deleteError } = await supabase
      .from("family_members")
      .delete()
      .not("id", "is", null);

    if (deleteError) throw deleteError;

    const { data, error } = await supabase
      .from("family_members")
      .insert(users.map((name) => ({ name })))
      .select();

    if (error) throw error;

    const sortedUsers = (data || [])
      .sort((a, b) => a.id - b.id)
      .map((member) => member.name);

    return res.json({
      users: sortedUsers,
    });
  } catch (error) {
    console.error("Feil i /api/family-members", error);

    return res.status(500).json({
      error: "Kunne ikke lagre familiemedlemmer.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.post("/api/items", async (req, res) => {
  try {
    const name = normalizeName(req.body?.name);
    const category = CATEGORY_VALUES.includes(req.body?.category)
      ? req.body.category
      : "Annet";
    const quantity = Number(req.body?.quantity) > 0 ? Number(req.body.quantity) : 1;
    const addedBy = String(req.body?.addedBy || "").trim() || null;

    if (!name) {
      return res.status(400).json({ error: "Mangler varenavn." });
    }

    const { data: existing, error: existingError } = await supabase
      .from("shopping_items")
      .select("*")
      .eq("normalized_name", name)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from("shopping_items")
        .update({
          quantity: Number(existing.quantity || 1) + quantity,
          added_by: addedBy || existing.added_by,
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (updateError) throw updateError;

      return res.json({ item: updated });
    }

    const { data: inserted, error: insertError } = await supabase
      .from("shopping_items")
      .insert({
        name: displayName(name),
        normalized_name: name,
        category,
        quantity,
        status: "active",
        added_by: addedBy,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    return res.json({ item: inserted });
  } catch (error) {
    console.error("Feil i /api/items", error);

    return res.status(500).json({
      error: "Kunne ikke lagre varen.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.post("/api/purchase", async (req, res) => {
  try {
    const itemId = Number(req.body?.itemId);
    const purchasedBy = String(req.body?.purchasedBy || "").trim() || null;

    if (!itemId) {
      return res.status(400).json({ error: "Mangler itemId." });
    }

    const { data: item, error: itemError } = await supabase
      .from("shopping_items")
      .select("*")
      .eq("id", itemId)
      .eq("status", "active")
      .maybeSingle();

    if (itemError) throw itemError;

    if (!item) {
      return res.status(404).json({ error: "Fant ikke aktiv vare." });
    }

    const purchaseRow = {
      name: item.name,
      normalized_name: item.normalized_name,
      category: item.category || "Annet",
      quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      purchased_by: purchasedBy,
    };

    const { data: insertedHistory, error: historyError } = await supabase
      .from("purchase_history")
      .insert(purchaseRow)
      .select()
      .single();

    if (historyError) throw historyError;

    const { error: suggestionError } = await supabase
      .from("suggestion_memory")
      .insert(purchaseRow);

    if (suggestionError) throw suggestionError;

    const { error: deleteError } = await supabase
      .from("shopping_items")
      .delete()
      .eq("id", item.id);

    if (deleteError) throw deleteError;

    return res.json({
      purchased: insertedHistory,
      removedItemId: item.id,
    });
  } catch (error) {
    console.error("Feil i /api/purchase", error);

    return res.status(500).json({
      error: "Kunne ikke markere varen som kjøpt.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.post("/api/shopping-sessions", async (req, res) => {
  try {
    const shopperName = String(req.body?.shopperName || "").trim();
    const totalAmount = Number(req.body?.totalAmount);
    const purchasedAt = String(req.body?.purchasedAt || "").trim();

    if (!shopperName) {
      return res.status(400).json({ error: "Mangler shopperName." });
    }

    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      return res.status(400).json({ error: "Ugyldig totalAmount." });
    }

    const rowToInsert = {
      shopper_name: shopperName,
      total_amount: totalAmount,
      purchased_at: purchasedAt || new Date().toISOString().slice(0, 10),
    };

    const { data, error } = await supabase
      .from("shopping_sessions")
      .insert(rowToInsert)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      session: data,
    });
  } catch (error) {
    console.error("Feil i /api/shopping-sessions", error);

    return res.status(500).json({
      error: "Kunne ikke lagre handleturen.",
      details: error?.message || "Ukjent feil",
    });
  }
});

app.delete("/api/history", async (_req, res) => {
  try {
    const { error } = await supabase
      .from("purchase_history")
      .delete()
      .not("id", "is", null);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (error) {
    console.error("Feil i DELETE /api/history", error);

    return res.status(500).json({
      error: "Kunne ikke tømme historikken.",
      details: error?.message || "Ukjent feil",
    });
  }
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
