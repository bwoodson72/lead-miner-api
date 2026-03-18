const FRANCHISE_DOMAINS: string[] = [
  // Neighborly family
  "aireserv.com",
  "mrrooter.com",
  "mrelectric.com",
  "mollymaids.com",
  "mosquitojoe.com",
  "rainbowintl.com",
  "windowgenie.com",
  "groundsguys.com",
  "glassdoctor.com",
  "fivestarpainting.com",
  "mrappliance.com",
  "realpropertymgmt.com",

  // Other franchise home services
  "onehourheatandair.com",
  "onehourair.com",
  "benjaminfranklinplumbing.com",
  "mistersparky.com",
  "servicemaster.com",
  "servpro.com",
  "stanleysteemer.com",
  "serviceexperts.com",
  "goettl.com",
  "horizonservices.com",
  "cooltoday.com",
  "acehomeservices.com",
  "hiller.com",
  "rotorooter.com",
  "handymanconnection.com",

  // Franchise dental / medical
  "aspendental.com",
  "pacificdentalservices.com",
  "heartlanddentalcare.com",
  "thejoint.com",

  // Franchise legal
  "morganandmorgan.com",

  // Franchise auto
  "maaco.com",
  "calibercollision.com",
  "serviceking.com",
  "takefivestops.com",
  "jiffylube.com",
  "meineke.com",
  "midas.com",
  "pepboys.com",
  "firestonecompleteautocare.com",
  "ntb.com",
];

export function isFranchise(domain: string): boolean {
  const d = domain.toLowerCase();
  return FRANCHISE_DOMAINS.some((fd) => d.includes(fd));
}
