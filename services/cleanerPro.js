import { cleanCsv } from "./cleanerBase.js";
import fs from "fs";
import ExcelJS from "exceljs";

/**
 * Plan Pro
 * - Nettoyage complet
 * - Fichiers max 100 Mo
 * - Export CSV + Excel
 * - Historique (à implémenter côté serveur/DB)
 */
export async function cleanPro(filePath) {
  // Vérification taille (100 Mo max)
  const stats = fs.statSync(filePath);
  if (stats.size > 100 * 1024 * 1024) {
    throw new Error("Fichier trop volumineux pour le plan Pro (100 Mo max).");
  }

  const result = cleanCsv(filePath, "pro");

  // Création d'un Excel en plus
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cleaned Data");
  result.cleaned.forEach(row => sheet.addRow(row));

  const outputXlsx = `outputs/CLEANED_pro_${Date.now()}.xlsx`;
  await workbook.xlsx.writeFile(outputXlsx);

  return {
    ...result,
    excelPath: outputXlsx,
    excelName: "CLEANED_pro.xlsx",
    note: "Plan Pro : CSV + Excel, fichiers jusqu’à 100 Mo, historique disponible."
  };
}
