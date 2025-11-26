import ExcelJS from "exceljs";
import fs from "fs";

export async function exportToExcel(rows, report, fileName, enriched = false) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cleaned CSV");

  rows.forEach(r => sheet.addRow(r));

  if (enriched) {
    const reportSheet = workbook.addWorksheet("Report");
    Object.entries(report).forEach(([k, v]) => {
      reportSheet.addRow([k, v]);
    });
  }

  const outputPath = "outputs/" + fileName.replace(".csv", ".xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}
