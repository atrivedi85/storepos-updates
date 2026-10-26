/* Ledger Desk merchant directory: recognizes common businesses and bank descriptors offline. */
(function (root) {
  'use strict';
  // Order matters: specific entries come before generic ones (e.g. Uber Eats before Uber).
  const DIRECTORY = [
    ['Interest Paid', ['INTEREST CHARGE', 'INTEREST CHG', 'FINANCE CHARGE', 'PURCHASE INTEREST', 'INTEREST ON PURCHASES', 'CASH ADVANCE INTEREST', 'PAY OVER TIME INTEREST', 'PLAN IT INTEREST']],
    ['Bank & Card Fees', ['ANNUAL FEE', 'ANNUAL MEMBERSHIP FEE', 'MEMBERSHIP FEE', 'LATE FEE', 'LATE PAYMENT FEE', 'FOREIGN TRANSACTION FEE', 'FOREIGN TRANS FEE', 'MONTHLY SERVICE FEE', 'SERVICE CHARGE', 'MAINTENANCE FEE', 'OVERDRAFT', 'NSF FEE', 'RETURNED ITEM FEE', 'WIRE FEE', 'WIRE TRANSFER FEE', 'ATM FEE', 'NON-CHASE ATM FEE', 'CASH ADVANCE FEE', 'BALANCE TRANSFER FEE', 'PLAN FEE', 'STOP PAYMENT FEE']],
    ['Dining & Meals', ['UBER EATS', 'UBER *EATS', 'UBEREATS', 'DOORDASH', 'GRUBHUB', 'POSTMATES', 'SEAMLESS', 'CAVIAR', 'EZCATER', 'STARBUCKS', 'MCDONALD', 'MCDONALDS', 'CHICK-FIL-A', 'CHICK FIL A', 'CHICKFILA', 'TACO BELL', 'WENDYS', 'WENDY S', 'BURGER KING', 'SUBWAY', 'CHIPOTLE', 'PANERA', 'DUNKIN', 'DOMINOS', 'DOMINO S', 'PIZZA HUT', 'PAPA JOHN', 'PAPA JOHNS', 'LITTLE CAESARS', 'OLIVE GARDEN', 'APPLEBEES', 'APPLEBEE S', 'CHILIS', 'CHILI S', 'TEXAS ROADHOUSE', 'OUTBACK', 'RED LOBSTER', 'BUFFALO WILD WINGS', 'BWW', 'IHOP', 'DENNYS', 'DENNY S', 'CRACKER BARREL', 'WAFFLE HOUSE', 'FIVE GUYS', 'SHAKE SHACK', 'PANDA EXPRESS', 'JIMMY JOHNS', 'JIMMY JOHN S', 'JERSEY MIKES', 'JERSEY MIKE S', 'FIREHOUSE SUBS', 'ARBYS', 'ARBY S', 'SONIC DRIVE', 'CULVERS', 'CULVER S', 'DAIRY QUEEN', 'KFC', 'POPEYES', 'ZAXBYS', 'RAISING CANES', 'RAISING CANE S', 'WINGSTOP', 'QDOBA', 'MOES', 'NOODLES & CO', 'NOODLES AND CO', 'CHEESECAKE FACTORY', 'LONGHORN', 'RED ROBIN', 'BOB EVANS', 'STEAK N SHAKE', 'WHITE CASTLE', 'JACK IN THE BOX', 'CARLS JR', 'HARDEES', 'HARDEE S', 'CHECKERS', 'BOJANGLES', 'TIM HORTONS', 'PEETS', 'CARIBOU COFFEE', 'DUTCH BROS', 'EINSTEIN BROS', 'BASKIN', 'COLD STONE', 'TST*', 'TST ', 'TOAST ']],
    ['Groceries', ['KROGER', 'PUBLIX', 'ALDI', 'WHOLE FOODS', 'WHOLEFDS', 'TRADER JOE', 'TRADER JOES', 'SAFEWAY', 'ALBERTSONS', 'MEIJER', 'H-E-B', 'HEB', 'WEGMANS', 'FOOD LION', 'HY-VEE', 'HYVEE', 'SCHNUCKS', 'GIANT EAGLE', 'SPROUTS', 'SHOPRITE', 'STOP & SHOP', 'HARRIS TEETER', 'WINN-DIXIE', 'WINN DIXIE', 'PIGGLY WIGGLY', 'FOOD 4 LESS', 'RALPHS', 'VONS', 'JEWEL OSCO', 'FRESH THYME', 'INSTACART', 'PATEL BROTHERS', 'INDIA BAZAAR', 'H MART', 'FRESH MARKET']],
    ['Utilities', ['SPECTRUM', 'CHARTER COMM', 'COMCAST', 'XFINITY', 'COX COMM', 'COX CABLE', 'OPTIMUM', 'ALTICE', 'SUDDENLINK', 'MEDIACOM', 'FRONTIER COMM', 'CENTURYLINK', 'LUMEN', 'WINDSTREAM', 'WOW INTERNET', 'ASTOUND', 'GOOGLE FIBER', 'STARLINK', 'HUGHESNET', 'VIASAT', 'DIRECTV', 'DISH NETWORK', 'DUKE ENERGY', 'CENTERPOINT', 'VECTREN', 'AMEREN', 'AEP ', 'DOMINION ENERGY', 'XCEL ENERGY', 'PG&E', 'PGE ', 'SOUTHERN CAL EDISON', 'GEORGIA POWER', 'ALABAMA POWER', 'FPL', 'FLORIDA POWER', 'ENTERGY', 'CON ED', 'CONEDISON', 'NATIONAL GRID', 'EVERSOURCE', 'PSEG', 'DTE ENERGY', 'CONSUMERS ENERGY', 'ATMOS ENERGY', 'NICOR', 'SPIRE ', 'PEOPLES GAS', 'NIPSCO', 'AES INDIANA', 'AES OHIO', 'LG&E', 'EVERGY', 'OG&E', 'TXU ENERGY', 'RELIANT ENERGY', 'DIRECT ENERGY', 'CITIZENS ENERGY', 'WASTE MANAGEMENT', 'WM SUPERCHECK', 'REPUBLIC SERVICES', 'WASTE CONNECTIONS', 'WATER DEPT', 'WATER UTIL', 'WATER WORKS', 'WATERWORKS', 'WATER & SEWER', 'WATER SEWER', 'SEWER', 'ELECTRIC CO', 'ELECTRIC COOP', 'ELECTRIC COMPANY', 'POWER CO', 'LIGHT & POWER', 'GAS CO', 'GAS COMPANY', 'ENERGY CO', 'UTILITIES', 'UTILITY']],
    ['Phone & Internet', ['VERIZON', 'VZWRLSS', 'AT&T', 'ATT ', 'T-MOBILE', 'T MOBILE', 'TMOBILE', 'SPRINT', 'US CELLULAR', 'CRICKET WIRELESS', 'METRO BY T', 'METROPCS', 'MINT MOBILE', 'VISIBLE', 'GOOGLE FI', 'BOOST MOBILE', 'STRAIGHT TALK', 'TRACFONE', 'RINGCENTRAL', 'VONAGE', 'GRASSHOPPER', 'OOMA', 'DIALPAD', 'NEXTIVA']],
    ['Advertising & Marketing', ['FACEBK', 'FACEBOOK ADS', 'META ADS', 'META PLATFORMS', 'GOOGLE ADS', 'GOOGLE *ADS', 'ADWORDS', 'LINKEDIN ADS', 'MICROSOFT ADS', 'BING ADS', 'TIKTOK ADS', 'YELP', 'NEXTDOOR', 'THUMBTACK', 'ANGI ', 'ANGIES LIST', 'HOMEADVISOR', 'VISTAPRINT ADS', 'CONSTANT CONTACT', 'MAILCHIMP', 'INTUIT MAILCHIMP', 'HUBSPOT', 'SEMRUSH']],
    ['Software & Subscriptions', ['AMAZON WEB SERVICES', 'AWS', 'ADOBE', 'MICROSOFT', 'MSFT', 'GOOGLE GSUITE', 'GOOGLE *GSUITE', 'GSUITE', 'GOOGLE WORKSPACE', 'GOOGLE STORAGE', 'GOOGLE ONE', 'GOOGLE CLOUD', 'YOUTUBE PREMIUM', 'YOUTUBE TV', 'APPLE.COM BILL', 'APPLE.COM/BILL', 'APPLE COM BILL', 'ICLOUD', 'DROPBOX', 'ZOOM', 'ZOOM.US', 'SLACK', 'INTUIT', 'QUICKBOOKS', 'CANVA', 'NOTION', 'ATLASSIAN', 'GITHUB', 'OPENAI', 'CHATGPT', 'ANTHROPIC', 'CLAUDE.AI', 'SHOPIFY', 'SQUARESPACE', 'WIX', 'GODADDY', 'NAMECHEAP', 'SALESFORCE', 'DOCUSIGN', 'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY PLUS', 'DISNEYPLUS', 'PRIME VIDEO', 'AMAZON PRIME', 'AUDIBLE', 'KINDLE UNLTD', 'PARAMOUNT', 'HBO MAX', 'MAX.COM', 'PEACOCK', 'SIRIUSXM', 'SIRIUS XM', 'LINKEDIN', 'ZOHO', 'NORTON', 'MCAFEE', '1PASSWORD', 'LASTPASS', 'DIGITALOCEAN', 'CLOUDFLARE', 'CALENDLY', 'GRAMMARLY', 'FRESHBOOKS', 'XERO', 'GUSTO', 'SQUARE SUBSCRIPTION', 'CLOVER', 'TOAST INC SUBSCR', 'PATREON', 'SUBSTACK', 'NYTIMES', 'WSJ', 'WALL STREET JOURNAL']],
    ['Office Supplies', ['STAPLES', 'OFFICE DEPOT', 'OFFICEMAX', 'VISTAPRINT', 'MOO PRINT', 'ULINE', 'FEDEX OFFICE', 'THE UPS STORE PRINT']],
    ['Shipping & Postage', ['USPS', 'US POSTAL', 'POST OFFICE', 'UPS', 'THE UPS STORE', 'FEDEX', 'FED EX', 'DHL', 'STAMPS.COM', 'STAMPS COM', 'PIRATE SHIP', 'PIRATESHIP', 'SHIPSTATION', 'EASYPOST', 'SHIPPO']],
    ['Insurance', ['STATE FARM', 'GEICO', 'PROGRESSIVE', 'ALLSTATE', 'LIBERTY MUTUAL', 'NATIONWIDE', 'FARMERS INS', 'USAA', 'TRAVELERS INS', 'THE HARTFORD', 'HARTFORD INS', 'NEXT INSURANCE', 'HISCOX', 'AFLAC', 'ERIE INS', 'AMERICAN FAMILY INS', 'METLIFE', 'PRUDENTIAL', 'INSURANCE', 'INS PREM', 'INS PMT']],
    ['Travel', ['DELTA AIR', 'DELTA', 'AMERICAN AIR', 'AMERICAN AIRLINES', 'AA.COM', 'UNITED AIR', 'UNITED AIRLINES', 'SOUTHWEST', 'SWA', 'JETBLUE', 'ALASKA AIR', 'SPIRIT AIRL', 'FRONTIER AIRLINES', 'ALLEGIANT', 'SUN COUNTRY', 'AIR CANADA', 'WESTJET', 'BRITISH AIRWAYS', 'LUFTHANSA', 'EMIRATES', 'AIR INDIA', 'QATAR AIRWAYS', 'MARRIOTT', 'HILTON', 'HYATT', 'HOLIDAY INN', 'IHG', 'HAMPTON INN', 'COURTYARD', 'FAIRFIELD INN', 'BEST WESTERN', 'WYNDHAM', 'LA QUINTA', 'MOTEL 6', 'RED ROOF', 'EMBASSY SUITES', 'DOUBLETREE', 'SHERATON', 'WESTIN', 'RADISSON', 'CHOICE HOTELS', 'COMFORT INN', 'AIRBNB', 'VRBO', 'EXPEDIA', 'BOOKING.COM', 'BOOKING COM', 'HOTELS.COM', 'PRICELINE', 'KAYAK', 'ALAMO', 'ENTERPRISE RENT', 'ENTERPRISE RENT-A-CAR', 'HERTZ', 'AVIS', 'BUDGET RENT', 'BUDGET CAR', 'NATIONAL CAR', 'THRIFTY', 'DOLLAR RENT', 'SIXT', 'TURO', 'LYFT', 'UBER', 'AMTRAK', 'GREYHOUND', 'TSA PRECHECK', 'AIRPORT PARKING']],
    ['Auto & Fuel', ['SHELL', 'EXXON', 'EXXONMOBIL', 'MOBIL', 'CHEVRON', 'BP', 'MARATHON', 'SPEEDWAY', 'CIRCLE K', 'SUNOCO', 'VALERO', 'CITGO', 'PHILLIPS 66', 'CONOCO', 'SINCLAIR', 'CASEYS', 'CASEY S', 'QUIKTRIP', 'QT ', 'RACETRAC', 'WAWA', 'SHEETZ', 'MURPHY USA', 'MURPHY EXPRESS', 'PILOT', 'FLYING J', 'LOVES TRAVEL', 'LOVE S', 'KWIK TRIP', 'KWIK STAR', 'THORNTONS', 'BUC-EE', 'BUCEES', 'GETGO', 'HOLIDAY STATION', 'COSTCO GAS', 'SAMS FUEL', 'KROGER FUEL', 'MEIJER GAS', 'AUTOZONE', 'OREILLY', 'O REILLY', 'ADVANCE AUTO', 'NAPA', 'PEP BOYS', 'JIFFY LUBE', 'VALVOLINE', 'TAKE 5', 'FIRESTONE', 'GOODYEAR', 'DISCOUNT TIRE', 'TIRE KINGDOM', 'MIDAS', 'MEINEKE', 'SAFELITE', 'CARMAX', 'CARVANA', 'TESLA', 'PARKMOBILE', 'SPOTHERO', 'PARKING', 'E-ZPASS', 'EZPASS', 'I-PASS', 'IPASS', 'SUNPASS', 'TOLLWAY', 'TOLL ', 'BMV', 'DMV', 'CAR WASH', 'CARWASH', 'FORD', 'TOYOTA', 'HONDA', 'CHEVROLET', 'NISSAN', 'HYUNDAI', 'KIA', 'SUBARU', 'MAZDA', 'JEEP', 'DODGE', 'CHRYSLER', 'RAM TRUCKS', 'GMC', 'BUICK', 'CADILLAC', 'LEXUS', 'ACURA', 'INFINITI', 'VOLKSWAGEN', 'BMW', 'MERCEDES', 'AUDI', 'VOLVO']],
    ['Repairs & Maintenance', ['HOME DEPOT', 'HOMEDEPOT', 'LOWES', 'LOWE S', 'MENARDS', 'ACE HARDWARE', 'TRUE VALUE', 'HARBOR FREIGHT', 'SHERWIN', 'NORTHERN TOOL', 'GRAINGER', 'FASTENAL', 'ROTO-ROOTER', 'ROTO ROOTER', 'PLUMBING', 'HVAC', 'HEATING & COOLING', 'ELECTRICIAN', 'LAWN', 'PEST CONTROL', 'TERMINIX', 'ORKIN', 'HANDYMAN']],
    ['Rent & Lease', ['RENT PAYMENT', 'LEASE PAYMENT', 'PROPERTY MANAGEMENT', 'PROPERTY MGMT', 'PUBLIC STORAGE', 'EXTRA SPACE', 'CUBESMART', 'LIFE STORAGE', 'U-HAUL STORAGE', 'REGUS', 'WEWORK', 'APPFOLIO', 'BUILDIUM', 'RENTCAFE']],
    ['Contractors', ['UPWORK', 'FIVERR', 'TOPTAL', 'FREELANCER.COM', '99DESIGNS', 'TASKRABBIT']],
    ['Shopping', ['AMAZON', 'AMZN', 'AMAZON MKTPL', 'AMAZON.COM', 'WALMART', 'WAL-MART', 'WM SUPERCENTER', 'TARGET', 'COSTCO', 'SAMS CLUB', 'SAM S CLUB', 'BJS WHOLESALE', 'BEST BUY', 'BESTBUY', 'EBAY', 'ETSY', 'KOHLS', 'KOHL S', 'MACYS', 'MACY S', 'TJ MAXX', 'TJMAXX', 'MARSHALLS', 'HOMEGOODS', 'ROSS STORES', 'ROSS DRESS', 'NORDSTROM', 'OLD NAVY', 'GAP', 'NIKE', 'IKEA', 'WAYFAIR', 'DOLLAR GENERAL', 'DOLLAR TREE', 'FAMILY DOLLAR', 'FIVE BELOW', 'CVS', 'WALGREENS', 'RITE AID', 'APPLE STORE', 'APPLE.COM', 'BED BATH', 'MICHAELS', 'HOBBY LOBBY', 'JOANN', 'PETSMART', 'PETCO', 'CHEWY', 'DICKS SPORTING', 'ACADEMY SPORTS', 'BURLINGTON', 'TEMU', 'SHEIN', 'ALIEXPRESS']]
  ];

  // Business-type words that card issuers (AmEx, Chase, Citi…) add to the transaction details
  const DESCRIPTORS = [
    ['Utilities', ['CABLE SVC', 'CABLE SERVICES', 'CABLE TV', 'CABLE & PAY TV', 'CABLE, SATELLITE', 'UTILITIES', 'UTILITY', 'ELECTRIC SVC', 'GAS SVC', 'WATER SVC', 'INTERNET SVC', 'INTERNET SERVICE']],
    ['Phone & Internet', ['TELECOM', 'TELEPHONE SVC', 'TELECOMMUNICATION', 'WIRELESS SVC', 'CELLULAR']],
    ['Auto & Fuel', ['AUTO DEALER', 'AUTOMOBILE DEALER', 'CAR DEALER', 'SERVICE STATION', 'GAS STATION', 'FUEL DISPENSER', 'AUTOMATED FUEL', 'FUEL', 'PETROLEUM', 'AUTO PARTS', 'AUTOMOTIVE', 'AUTO SERVICE', 'AUTO REPAIR', 'TIRE', 'CAR WASH', 'PARKING', 'TOLL']],
    ['Travel', ['CAR RENTAL', 'AUTO RENTAL', 'TRUCK RENTAL', 'AIRLINE', 'AIR LINES', 'PASSENGER TICKET', 'HOTEL', 'MOTEL', 'LODGING', 'RESORT', 'TRAVEL AGENC', 'TAXI', 'LIMOUSINE', 'RIDESHARE', 'RAILROAD', 'BUS LINE']],
    ['Dining & Meals', ['RESTAURANT', 'FAST FOOD', 'EATING PLACE', 'CAFE', 'COFFEE', 'BAKERY', 'PIZZA', 'GRILL', 'DINER', 'STEAKHOUSE', 'SUSHI', 'TAQUERIA', 'BBQ', 'BAR & GRILL', 'CATERER', 'FOOD DELIVERY']],
    ['Groceries', ['GROCERY', 'SUPERMARKET', 'FOOD STORE']],
    ['Software & Subscriptions', ['SOFTWARE', 'DIGITAL GOODS', 'COMPUTER SVC', 'COMPUTER NETWORK', 'STREAMING', 'SUBSCRIPTION']],
    ['Advertising & Marketing', ['ADVERTISING', 'MARKETING SVC']],
    ['Insurance', ['INSURANCE']],
    ['Shipping & Postage', ['COURIER', 'POSTAL', 'SHIPPING', 'FREIGHT']],
    ['Office Supplies', ['OFFICE SUPPLY', 'OFFICE SUPPLIES', 'STATIONERY', 'PRINTING']],
    ['Repairs & Maintenance', ['HARDWARE', 'HOME IMPROVEMENT', 'BUILDING MATERIAL', 'PLUMBING', 'HEATING', 'CONTRACTOR SVC']],
    ['Shopping', ['DEPARTMENT STORE', 'DISCOUNT STORE', 'WAREHOUSE CLUB', 'ELECTRONICS', 'CLOTHING', 'APPAREL', 'MERCHANDISE', 'DRUG STORE', 'PHARMACY']]
  ];

  // Merchant category codes (MCC/SIC) some banks put in the file
  const CODES = [
    [[4900, 4900], 'Utilities'], [[4899, 4899], 'Utilities'],
    [[4812, 4816], 'Phone & Internet'],
    [[5411, 5411], 'Groceries'], [[5422, 5499], 'Groceries'],
    [[5811, 5814], 'Dining & Meals'],
    [[5511, 5599], 'Auto & Fuel'], [[7531, 7549], 'Auto & Fuel'], [[5532, 5533], 'Auto & Fuel'], [[7523, 7523], 'Auto & Fuel'], [[4784, 4784], 'Auto & Fuel'],
    [[3000, 3299], 'Travel'], [[4511, 4511], 'Travel'], [[3351, 3441], 'Travel'], [[7512, 7513], 'Travel'], [[3501, 3999], 'Travel'], [[7011, 7011], 'Travel'], [[4111, 4131], 'Travel'], [[4411, 4411], 'Travel'], [[4722, 4722], 'Travel'],
    [[4214, 4215], 'Shipping & Postage'], [[9402, 9402], 'Shipping & Postage'],
    [[5111, 5111], 'Office Supplies'], [[5943, 5943], 'Office Supplies'], [[2741, 2741], 'Office Supplies'],
    [[5734, 5734], 'Software & Subscriptions'], [[5815, 5818], 'Software & Subscriptions'], [[7372, 7372], 'Software & Subscriptions'], [[4816, 4816], 'Software & Subscriptions'],
    [[7311, 7311], 'Advertising & Marketing'],
    [[6300, 6399], 'Insurance'], [[5960, 5960], 'Insurance'],
    [[5200, 5251], 'Repairs & Maintenance'], [[1520, 1799], 'Repairs & Maintenance'],
    [[6513, 6513], 'Rent & Lease'],
    [[5300, 5399], 'Shopping'], [[5310, 5311], 'Shopping'], [[5611, 5699], 'Shopping'], [[5732, 5732], 'Shopping'], [[5912, 5912], 'Shopping'], [[5942, 5942], 'Shopping']
  ];

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = s => ' ' + String(s || '').toUpperCase().replace(/[’']/g, '').replace(/[^A-Z0-9&.*\/ -]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const compiled = DIRECTORY.map(([cat, words]) => ({
    cat,
    list: words.map(w => ({ w: w.trim(), re: new RegExp('(?:^|[^A-Z0-9])' + esc(w.trim()) + '(?=$|[^A-Z0-9])') }))
  }));
  function inDirectory(text) {
    for (const g of compiled) for (const k of g.list) if (k.re.test(text)) return { category: g.cat, word: k.w };
    return null;
  }
  // Letters must not touch the word, but digits may (issuers often glue a reference number on: "R1150770479CABLE SVC")
  const descCompiled = DESCRIPTORS.map(([cat, words]) => ({ cat, list: words.map(w => ({ w, re: new RegExp('(?:^|[^A-Z])' + esc(w) + '(?=$|[^A-Z])') })) }));
  function inDescriptors(text) {
    for (const g of descCompiled) for (const k of g.list) if (k.re.test(text)) return { category: g.cat, word: k.w };
    return null;
  }
  function inCodes(sic) {
    const n = parseInt(sic, 10); if (!n) return null;
    for (const [[a, b], cat] of CODES) if (n >= a && n <= b) return { category: cat, word: 'code ' + n };
    return null;
  }
  const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

  // Returns { category, why } or null. Payee is trusted most, then the bank's business-type words, then codes, then the memo.
  function lookup(payee, memo, sic) {
    const p = norm(payee), m = norm(memo);
    let hit = inDirectory(p);
    if (hit) return { category: hit.category, why: 'Recognized ' + titleCase(hit.word) };
    hit = inDescriptors(p + m);
    if (hit) return { category: hit.category, why: 'Bank describes it as "' + titleCase(hit.word) + '"' };
    hit = inCodes(sic);
    if (hit) return { category: hit.category, why: 'Merchant category ' + hit.word };
    hit = inDirectory(m);
    if (hit) return { category: hit.category, why: 'Recognized ' + titleCase(hit.word) + ' in the details' };
    return null;
  }

  const TRANSFER_HINT = /\b(PAYMENT|PMT|PYMT|PAYMNT|TRANSFER|XFER|TRNSFR|AUTOPAY|AUTO PAY|AUTO-PAY|EPAY|E-PAY|E-PAYMENT|EPAYMENT|ONLINE PMT|ONLINE PAYMENT|THANK YOU|ACH|AMEX|AMERICAN EXPRESS|CHASE|CITI|CITIBANK|CITICARD|DISCOVER|CAPITAL ONE|CAPITALONE|BARCLAYCARD|BARCLAYS|SYNCHRONY|WELLS FARGO|BANK OF AMERICA|BK OF AMER|BOFA|US BANK|USBANK|CREDIT CARD|CRCARD|CARDMEMBER|CARD SERVICES|APPLECARD|GSBANK)\b/;
  function looksLikeTransfer(payee, memo) { return TRANSFER_HINT.test(String(payee || '').toUpperCase() + ' ' + String(memo || '').toUpperCase()); }

  root.LedgerMerchants = { lookup, looksLikeTransfer, size: DIRECTORY.reduce((n, g) => n + g[1].length, 0) };
})(typeof window !== 'undefined' ? window : globalThis);
