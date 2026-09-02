import ExcelJS from 'exceljs';

export async function buildReport(targetDate, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'School Eat MAX Bot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Заказы', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const sortedRows = [...rows].sort(
    (left, right) =>
      left.className.localeCompare(right.className, 'ru') ||
      left.childName.localeCompare(right.childName, 'ru'),
  );
  const tableRows = sortedRows.length
    ? sortedRows.map((row) => [
        row.className,
        row.childName,
        row.breakfast ? '✓' : '—',
        row.lunch ? '✓' : '—',
      ])
    : [['—', 'Нет зарегистрированных учеников', '—', '—']];

  sheet.addTable({
    name: 'Orders',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [
      { name: 'Класс', filterButton: true },
      { name: 'ФИО', filterButton: true },
      { name: 'Завтрак', filterButton: true },
      { name: 'Обед', filterButton: true },
    ],
    rows: tableRows,
  });

  sheet.columns = [{ width: 13 }, { width: 38 }, { width: 14 }, { width: 14 }];
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = { horizontal: 'center' };
  });
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    for (const columnNumber of [3, 4]) {
      const cell = sheet.getCell(rowNumber, columnNumber);
      cell.alignment = { horizontal: 'center' };
      if (cell.value === '✓') cell.font = { color: { argb: 'FF008000' }, bold: true, size: 14 };
    }
  }
  sheet.headerFooter.oddHeader = `&CЗаказы на ${targetDate.split('-').reverse().join('.')}`;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
