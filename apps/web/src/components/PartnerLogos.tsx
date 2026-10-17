export default function PartnerLogos({compact=false}:{compact?:boolean}){
  return <div className={'partner-branding'+(compact?' partner-branding--compact':'')} role="group" aria-label="TYKS and MYLAB">
    <img className="partner-logo-tyks" src="/branding/tyks.png" alt="TYKS" width={1024} height={392} decoding="async"/>
    <span className="partner-logo-divider" aria-hidden="true"/>
    <img className="partner-logo-mylab" src="/branding/mylab.svg" alt="MYLAB" width={103} height={20} decoding="async"/>
  </div>;
}
