// src/components/component/header
const Header = () => {
  return (
    <header 
      className="
        absolute top-0
        flex justify-center items-center 
        w-full h-16 
        text-4xl font-extrabold text-cyan-500
        select-none
      "
    >
      <img src="/src/assets/images/codingPT.png" alt="CodingPT Logo" />
    </header>
  )
}
export default Header;