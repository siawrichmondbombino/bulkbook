-- OPTIONAL. Sample goods so the app is not empty on day one. Delete or edit them later.
-- Cost prices are filled in so reports show profit. Replace with your own goods and prices.
-- Stock is stored in pieces (box goods) or half-bags (bag goods): 25 bags = 50.
insert into public.products (sku, name, category, sell_type, pieces_per_box, price_piece, price_box, price_bag, cost, stock_base, low_base) values
 ('RIC-1001', 'Long grain rice 25kg',  'Grains',    'bag', null, null, null, 320, 270, 240, 60),
 ('SUG-1002', 'Sugar 50kg',            'Grains',    'bag', null, null, null, 480, 410, 150, 40),
 ('TOM-1003', 'Tomato paste 70g',      'Canned',    'box', 50,   8.50, 400,  null, 6.40, 1217, 300),
 ('OIL-1004', 'Vegetable oil 1L',      'Oils',      'box', 12,   38,   440,  null, 31,  173,  48),
 ('WTR-1005', 'Bottled water 500ml',   'Drinks',    'box', 24,   2.50, 55,   null, 1.90, 1440, 240),
 ('SOP-1006', 'Laundry soap bar',      'Household', 'box', 36,   4.50, 150,  null, 3.40, 657,  72);
-- Note: the sku numbers above are fixed text; new goods added in the app get their own numbers.
