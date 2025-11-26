import { cleanCsv } from "./cleanerBase.js";
import fs from "fs";

/**
 * Plan standard
 * - Nettoyage complet
 * - Fichiers max 20 Mo
 * - Export CSV uniquement
 * - Usage illimité
 */
export async function cleanStandard(filePath) {
  // Vérification taille (20 Mo max)
  const stats = fs.statSync(filePath);
  if (stats.size > 20 * 1024 * 1024) {
    throw new Error("Fichier trop volumineux pour le plan Standard (20 Mo max).");
  }

  const result = cleanCsv(filePath, "standard");

  return {
    ...result,
    note: "Plan Standard : nettoyage complet, CSV jusqu’à 20 Mo, usage illimité."
  };
}
